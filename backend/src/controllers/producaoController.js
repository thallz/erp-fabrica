const pool = require('../config/db');

async function explodirReceitaRec(client, receitaId, pesoNecessarioKg, insumosAcumulados = {}) {
    const items = await client.query(
        'SELECT * FROM receita_item WHERE receita_id = $1',
        [receitaId]
    );
    const recRes = await client.query('SELECT peso_total FROM receita WHERE id = $1', [receitaId]);
    const pesoTotalReceita = parseFloat(recRes.rows[0]?.peso_total || 10.0);
    const scaleFactor = pesoTotalReceita > 0 ? (pesoNecessarioKg / pesoTotalReceita) : 0;

    for (const item of items.rows) {
        const qtdKg = (parseFloat(item.quantidade_gramas) / 1000.0) * scaleFactor;
        if (item.tipo_origem === 'materia') {
            if (!insumosAcumulados[item.origem_id]) {
                insumosAcumulados[item.origem_id] = {
                    nome: item.nome,
                    quantidade_total: 0
                };
            }
            insumosAcumulados[item.origem_id].quantidade_total += qtdKg;
        } else if (item.tipo_origem === 'receita') {
            await explodirReceitaRec(client, item.origem_id, qtdKg, insumosAcumulados);
        }
    }
    return insumosAcumulados;
}

async function explodirEPrefabricarOPs(client, montagemOpId, produtoId, quantidadeMontagem) {
    const receitasExigidas = await client.query(
        `SELECT receita_id, quantidade_necessaria FROM ficha_tecnica_receita WHERE produto_id = $1`,
        [produtoId]
    );

    for (const r of receitasExigidas.rows) {
        const receitaId = r.receita_id;
        const pesoNecessario = parseFloat(r.quantidade_necessaria) * quantidadeMontagem;

        const recEstRes = await client.query(
            `SELECT COALESCE(estoque_atual, 0) AS estoque_atual FROM receita WHERE id = $1`,
            [receitaId]
        );
        
        let estoquePronto = 0;
        if (recEstRes.rows.length > 0) {
            estoquePronto = parseFloat(recEstRes.rows[0].estoque_atual || 0);
        }

        if (pesoNecessario > estoquePronto) {
            const pesoFalta = pesoNecessario - estoquePronto;
            const qtdPreparoKg = Math.ceil(pesoFalta);

            // Criar OP de PREPARO
            await client.query(
                `INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, tipo_op, receita_id, parent_op_id, categoria_producao)
                 VALUES ($1, $2, 'FILA', 'PREPARO', $3, $4, 'Preparo')`,
                [produtoId, qtdPreparoKg, receitaId, montagemOpId]
            );

            // Abater estoque consumido
            await client.query(
                `UPDATE receita SET estoque_atual = 0 WHERE id = $1`,
                [receitaId]
            );
        } else {
            const novoEstoque = estoquePronto - pesoNecessario;
            await client.query(
                `UPDATE receita SET estoque_atual = $1 WHERE id = $2`,
                [novoEstoque, receitaId]
            );
        }
    }
}

const producaoController = {
    alocar: async (req, res) => {
        try {
            const { produto_id, quantidade_planejada } = req.body;

            const ficha = await pool.query(
                `SELECT 
                    (SELECT COUNT(*)::int FROM ficha_tecnica_insumo WHERE produto_id = $1) +
                    (SELECT COUNT(*)::int FROM ficha_tecnica_embalagem WHERE produto_id = $1) +
                    (SELECT COUNT(*)::int FROM ficha_tecnica_receita WHERE produto_id = $1) AS total`,
                [produto_id]
            );
            if (ficha.rows[0].total === 0) {
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Produto sem ficha técnica cadastrada (receitas, insumos ou embalagens).'
                });
            }

            const novaOp = await pool.query(
                `INSERT INTO ordem_producao (produto_id, quantidade_planejada, status)
                 VALUES ($1, $2, 'FILA') RETURNING *`,
                [produto_id, quantidade_planejada]
            );

            res.status(201).json(novaOp.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    listarFila: async (req, res) => {
        try {
            const { status } = req.query;
            let query = `
                SELECT op.id AS numero_op, op.id, op.produto_id, p.nome AS produto,
                       op.quantidade_planejada, op.status, op.criado_em,
                       p.estoque_atual AS estoque_camara_fria,
                       op.data_programada, op.colaborador_id, op.categoria_producao,
                       c.nome AS colaborador_nome, p.peso_produtividade,
                       op.tipo_op, op.receita_id, r.nome AS receita_nome
                FROM ordem_producao op
                JOIN produto p ON op.produto_id = p.id
                LEFT JOIN colaborador c ON op.colaborador_id = c.id
                LEFT JOIN receita r ON r.id = op.receita_id
            `;
            const params = [];
            if (status) {
                query += ` WHERE op.status = $1`;
                params.push(status);
            }
            query += ` ORDER BY op.criado_em DESC`;

            const fila = await pool.query(query, params);
            res.json(fila.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    excluirOP: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query(
                'DELETE FROM ordem_producao WHERE id = $1 RETURNING id',
                [id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'OP não encontrada' });
            }
            res.json({ status: 'sucesso', mensagem: 'OP excluída com sucesso.', id: result.rows[0].id });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    registrarIntercorrencia: async (req, res) => {
        try {
            const { ordem_producao_id, codigo_intercorrencia, tempo_parada_minutos, observacao } = req.body;

            const ocorrencia = await pool.query(
                `INSERT INTO apontamento_intercorrencia
                (ordem_producao_id, codigo_intercorrencia, tempo_parada_minutos, observacao)
                VALUES ($1, $2, $3, $4) RETURNING *`,
                [ordem_producao_id, codigo_intercorrencia, tempo_parada_minutos, observacao]
            );

            res.status(201).json({
                status: 'sucesso',
                mensagem: 'Intercorrência registrada com sucesso.',
                dados: ocorrencia.rows[0]
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    verificarImpedimentosOP: async (req, res) => {
        try {
            const { op_id } = req.params;

            // Buscar a OP
            const op = await pool.query(
                `SELECT op.id, op.produto_id, op.quantidade_planejada, p.nome AS produto_nome
                 FROM ordem_producao op
                 JOIN produto p ON p.id = op.produto_id
                 WHERE op.id = $1`,
                [op_id]
            );

            if (op.rows.length === 0) {
                return res.status(404).json({
                    status: 'erro',
                    erro: 'OP não encontrada'
                });
            }

            const opData = op.rows[0];

            const impedimentos = [];
            const avisos = [];

            if (opData.tipo_op === 'PREPARO') {
                // Obter peso_total da receita
                const recRes = await pool.query('SELECT peso_total, nome FROM receita WHERE id = $1', [opData.receita_id]);
                if (recRes.rows.length === 0) {
                    return res.status(404).json({ status: 'erro', erro: 'Receita não encontrada' });
                }
                const pesoTotalReceita = parseFloat(recRes.rows[0].peso_total || 10.0);
                const scaleFactor = opData.quantidade_planejada / pesoTotalReceita;

                const items = await pool.query(`
                    SELECT ri.origem_id AS insumo_id, ri.nome, ri.quantidade_gramas, 
                           i.unidade_medida, i.estoque_atual
                    FROM receita_item ri
                    LEFT JOIN insumo i ON i.id = ri.origem_id
                    WHERE ri.receita_id = $1
                `, [opData.receita_id]);

                for (const ri of items.rows) {
                    const qtdNecessaria = (parseFloat(ri.quantidade_gramas) / 1000.0) * scaleFactor;
                    const qtdDisponivel = parseFloat(ri.estoque_atual || 0);
                    const falta = qtdNecessaria - qtdDisponivel;

                    if (falta > 0) {
                        impedimentos.push({
                            tipo: 'insumo',
                            nome: ri.nome,
                            necessario: qtdNecessaria.toFixed(4),
                            disponivel: qtdDisponivel.toFixed(4),
                            falta: falta.toFixed(4),
                            unidade: ri.unidade_medida || 'kg'
                        });
                    }
                }

                if (items.rows.length === 0) {
                    avisos.push('Receita sem insumos cadastrados.');
                }

                const temImpedimentos = impedimentos.length > 0;

                return res.json({
                    op_id: opData.id,
                    produto: recRes.rows[0].nome,
                    quantidade_planejada: opData.quantidade_planejada,
                    tem_impedimentos: temImpedimentos,
                    impedimentos: impedimentos,
                    avisos: avisos,
                    status_estoque: temImpedimentos ? 'IMPEDIMENTO' : 'OK'
                });
            }

            // Caso padrão: MONTAGEM (Produto Final)
            // 1. Obter direct insumos
            const fichasInsumo = await pool.query(`
                SELECT fti.insumo_id, fti.quantidade, i.nome, i.unidade_medida,
                       i.estoque_atual
                FROM ficha_tecnica_insumo fti
                JOIN insumo i ON i.id = fti.insumo_id
                WHERE fti.produto_id = $1
            `, [opData.produto_id]);

            // 2. Obter direct embalagens
            const fichasEmb = await pool.query(`
                SELECT fte.embalagem_id, fte.quantidade, e.nome, e.estoque_atual
                FROM ficha_tecnica_embalagem fte
                JOIN embalagem e ON e.id = fte.embalagem_id
                WHERE fte.produto_id = $1
            `, [opData.produto_id]);

            // 3. Obter receitas e explodir recursivamente
            const fichasReceita = await pool.query(`
                SELECT receita_id, quantidade_necessaria 
                FROM ficha_tecnica_receita 
                WHERE produto_id = $1
            `, [opData.produto_id]);

            // Demanda acumulada de insumos
            const demandasInsumos = {};
            
            // Adicionar insumos diretos
            for (const f of fichasInsumo.rows) {
                if (!demandasInsumos[f.insumo_id]) {
                    demandasInsumos[f.insumo_id] = {
                        nome: f.nome,
                        quantidade_total: 0,
                        estoque_atual: parseFloat(f.estoque_atual || 0),
                        unidade_medida: f.unidade_medida || 'kg'
                    };
                }
                demandasInsumos[f.insumo_id].quantidade_total += parseFloat(f.quantidade) * opData.quantidade_planejada;
            }

            // Explodir receitas
            for (const r of fichasReceita.rows) {
                const pesoReceitaKg = parseFloat(r.quantidade_necessaria) * opData.quantidade_planejada;
                const acumulador = {};
                await explodirReceitaRec(pool, r.receita_id, pesoReceitaKg, acumulador);

                for (const insumoId of Object.keys(acumulador)) {
                    const item = acumulador[insumoId];
                    if (!demandasInsumos[insumoId]) {
                        // Buscar estoque do insumo
                        const insEst = await pool.query('SELECT nome, estoque_atual, unidade_medida FROM insumo WHERE id = $1', [insumoId]);
                        if (insEst.rows.length > 0) {
                            demandasInsumos[insumoId] = {
                                nome: insEst.rows[0].nome,
                                quantidade_total: 0,
                                estoque_atual: parseFloat(insEst.rows[0].estoque_atual || 0),
                                unidade_medida: insEst.rows[0].unidade_medida || 'kg'
                            };
                        }
                    }
                    if (demandasInsumos[insumoId]) {
                        demandasInsumos[insumoId].quantidade_total += item.quantidade_total;
                    }
                }
            }

            // Verificar impedimentos dos insumos acumulados
            for (const insumoId of Object.keys(demandasInsumos)) {
                const item = demandasInsumos[insumoId];
                const falta = item.quantidade_total - item.estoque_atual;
                if (falta > 0) {
                    impedimentos.push({
                        tipo: 'insumo',
                        nome: item.nome,
                        necessario: item.quantidade_total.toFixed(4),
                        disponivel: item.estoque_atual.toFixed(4),
                        falta: falta.toFixed(4),
                        unidade: item.unidade_medida
                    });
                }
            }

            // Verificar impedimentos das embalagens diretas
            for (const e of fichasEmb.rows) {
                const qtdNecessaria = parseInt(e.quantidade, 10) * opData.quantidade_planejada;
                const qtdDisponivel = parseInt(e.estoque_atual || 0, 10);
                const falta = qtdNecessaria - qtdDisponivel;

                if (falta > 0) {
                    impedimentos.push({
                        tipo: 'embalagem',
                        nome: e.nome,
                        necessario: qtdNecessaria,
                        disponivel: qtdDisponivel,
                        falta: falta,
                        unidade: 'un'
                    });
                }
            }

            if (fichasInsumo.rows.length === 0 && fichasEmb.rows.length === 0 && fichasReceita.rows.length === 0) {
                avisos.push('Produto sem ficha técnica cadastrada.');
            }

            const temImpedimentos = impedimentos.length > 0;

            res.json({
                op_id: opData.id,
                produto: opData.produto_nome,
                quantidade_planejada: opData.quantidade_planejada,
                tem_impedimentos: temImpedimentos,
                impedimentos: impedimentos,
                avisos: avisos,
                status_estoque: temImpedimentos ? 'IMPEDIMENTO' : 'OK'
            });

        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    planejarProducao: async (req, res) => {
        try {
            const { colaborador_id, data_programada, ops_ids } = req.body;

            if (!colaborador_id || !data_programada || !ops_ids || !Array.isArray(ops_ids)) {
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Campos obrigatórios: colaborador_id, data_programada, ops_ids (array)'
                });
            }

            // Buscar a meta diária do colaborador (individual)
            const colaborador = await pool.query(
                'SELECT nome, meta_diaria_individual FROM colaborador WHERE id = $1 AND ativo = TRUE',
                [colaborador_id]
            );

            if (colaborador.rows.length === 0) {
                return res.status(404).json({
                    status: 'erro',
                    erro: 'Colaborador não encontrado ou inativo'
                });
            }

            const metaDiariaIndividual = colaborador.rows[0].meta_diaria_individual;
            const nomeColaborador = colaborador.rows[0].nome;

            // Buscar quantidade planejada calculada em pontos (qtd * peso) para o colaborador na data
            const opsExistentes = await pool.query(
                `SELECT SUM(op.quantidade_planejada * COALESCE(p.peso_produtividade, 1.0)) as total_planejado
                 FROM ordem_producao op
                 JOIN produto p ON p.id = op.produto_id
                 WHERE op.colaborador_id = $1
                 AND op.data_programada = $2
                 AND op.status != 'CONCLUIDA'`,
                [colaborador_id, data_programada]
            );

            const totalPlanejado = parseFloat(opsExistentes.rows[0].total_planejado || 0);

            // Buscar quantidade das novas OPs com peso_produtividade
            const novasOps = await pool.query(
                `SELECT op.id, op.quantidade_planejada, op.produto_id, COALESCE(p.peso_produtividade, 1.0) as peso_produtividade
                 FROM ordem_producao op
                 JOIN produto p ON p.id = op.produto_id
                 WHERE op.id = ANY($1)`,
                [ops_ids]
            );

            if (novasOps.rows.length === 0) {
                return res.status(404).json({
                    status: 'erro',
                    erro: 'Nenhuma OP válida encontrada'
                });
            }

            const totalNovasOps = novasOps.rows.reduce((sum, op) => sum + (op.quantidade_planejada * parseFloat(op.peso_produtividade)), 0);
            const novoTotal = totalPlanejado + totalNovasOps;

            // Verificar se ultrapassa a meta
            const ultrapassaMeta = novoTotal > metaDiariaIndividual;
            const aviso = ultrapassaMeta
                ? `⚠️ ALERTA: Alocação ultrapassa meta diária! Pontos Planejados: ${totalPlanejado.toFixed(1)}, Novas OPs: ${totalNovasOps.toFixed(1)}, Total: ${novoTotal.toFixed(1)}, Meta: ${metaDiariaIndividual}. Sobrecarga de ${(novoTotal - metaDiariaIndividual).toFixed(1)} pontos.`
                : null;

            // Atualizar as OPs com o colaborador e data programada
            const updates = [];
            for (const op of novasOps.rows) {
                const update = await pool.query(
                    `UPDATE ordem_producao
                     SET colaborador_id = $1, data_programada = $2
                     WHERE id = $3
                     RETURNING *`,
                    [colaborador_id, data_programada, op.id]
                );
                updates.push(update.rows[0]);
            }

            res.json({
                status: 'sucesso',
                mensagem: 'Produção planejada com sucesso.',
                colaborador: nomeColaborador,
                data_programada,
                meta_diaria_individual: metaDiariaIndividual,
                total_planejado_anterior: totalPlanejado,
                total_novas_ops: totalNovasOps,
                total_geral: novoTotal,
                ultrapassa_meta: ultrapassaMeta,
                aviso,
                ops_atualizadas: updates
            });

        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    necessidadeCompras: async (req, res) => {
        try {
            const margem = parseFloat(req.query.margem) || 0;
            const multiplicador = 1 + Math.max(0, margem);

            const ops = await pool.query(`
                SELECT op.id, op.produto_id, op.quantidade_planejada, p.nome AS produto_nome
                FROM ordem_producao op
                JOIN produto p ON p.id = op.produto_id
                WHERE op.status = 'FILA'
                ORDER BY op.criado_em ASC
            `);

            const demandaInsumos = {};
            const demandaEmbalagens = {};
            const avisos = [];
            const detalheOps = [];

            for (const op of ops.rows) {
                const fichasInsumo = await pool.query(`
                    SELECT fti.insumo_id, fti.quantidade, i.nome, i.unidade_medida,
                           i.estoque_atual, i.custo_unitario
                    FROM ficha_tecnica_insumo fti
                    JOIN insumo i ON i.id = fti.insumo_id
                    WHERE fti.produto_id = $1
                `, [op.produto_id]);

                const fichasEmb = await pool.query(`
                    SELECT fte.embalagem_id, fte.quantidade, e.nome, e.estoque_atual, e.custo_unitario
                    FROM ficha_tecnica_embalagem fte
                    JOIN embalagem e ON e.id = fte.embalagem_id
                    WHERE fte.produto_id = $1
                `, [op.produto_id]);

                const fichasReceita = await pool.query(`
                    SELECT receita_id, quantidade_necessaria 
                    FROM ficha_tecnica_receita 
                    WHERE produto_id = $1
                `, [op.produto_id]);

                if (fichasInsumo.rows.length === 0 && fichasEmb.rows.length === 0 && fichasReceita.rows.length === 0) {
                    avisos.push(`"${op.produto_nome}" (OP #${op.id}): sem ficha técnica — explosão ignorada.`);
                }

                detalheOps.push({
                    op_id: op.id,
                    produto: op.produto_nome,
                    quantidade_planejada: op.quantidade_planejada
                });

                // Insumos diretos
                for (const f of fichasInsumo.rows) {
                    const qtdNecessaria = parseFloat(f.quantidade) * op.quantidade_planejada * multiplicador;
                    if (!demandaInsumos[f.insumo_id]) {
                        demandaInsumos[f.insumo_id] = {
                            insumo_id: f.insumo_id,
                            nome: f.nome,
                            unidade_medida: f.unidade_medida,
                            estoque_atual: parseFloat(f.estoque_atual),
                            custo_unitario: parseFloat(f.custo_unitario),
                            demanda_total: 0
                        };
                    }
                    demandaInsumos[f.insumo_id].demanda_total += qtdNecessaria;
                }

                // Receitas explodidas
                for (const r of fichasReceita.rows) {
                    const pesoReceitaKg = parseFloat(r.quantidade_necessaria) * op.quantidade_planejada * multiplicador;
                    const acumulador = {};
                    await explodirReceitaRec(pool, r.receita_id, pesoReceitaKg, acumulador);

                    for (const insumoId of Object.keys(acumulador)) {
                        const item = acumulador[insumoId];
                        if (!demandaInsumos[insumoId]) {
                            // Buscar estoque e custo do insumo
                            const insEst = await pool.query('SELECT nome, estoque_atual, custo_unitario, unidade_medida FROM insumo WHERE id = $1', [insumoId]);
                            if (insEst.rows.length > 0) {
                                demandaInsumos[insumoId] = {
                                    insumo_id: parseInt(insumoId, 10),
                                    nome: insEst.rows[0].nome,
                                    unidade_medida: insEst.rows[0].unidade_medida || 'kg',
                                    estoque_atual: parseFloat(insEst.rows[0].estoque_atual || 0),
                                    custo_unitario: parseFloat(insEst.rows[0].custo_unitario || 0),
                                    demanda_total: 0
                                };
                            }
                        }
                        if (demandaInsumos[insumoId]) {
                            demandaInsumos[insumoId].demanda_total += item.quantidade_total;
                        }
                    }
                }

                // Embalagens diretas
                for (const e of fichasEmb.rows) {
                    const qtdNecessaria = parseInt(e.quantidade, 10) * op.quantidade_planejada * multiplicador;
                    if (!demandaEmbalagens[e.embalagem_id]) {
                        demandaEmbalagens[e.embalagem_id] = {
                            embalagem_id: e.embalagem_id,
                            nome: e.nome,
                            unidade_medida: 'un',
                            estoque_atual: parseInt(e.estoque_atual || 0, 10),
                            custo_unitario: parseFloat(e.custo_unitario || 0),
                            demanda_total: 0
                        };
                    }
                    demandaEmbalagens[e.embalagem_id].demanda_total += qtdNecessaria;
                }
            }

            const montarLista = (mapa, tipo) => Object.values(mapa)
                .map((item) => {
                    const quantidade_comprar = Math.max(0, item.demanda_total - item.estoque_atual);
                    const status_estoque = quantidade_comprar > 0 ? 'IMPEDIMENTO' : 'OK';
                    return {
                        tipo,
                        id: item.insumo_id || item.embalagem_id,
                        nome: item.nome,
                        unidade_medida: item.unidade_medida,
                        demanda_total: parseFloat(item.demanda_total.toFixed(4)),
                        estoque_atual: item.estoque_atual,
                        quantidade_comprar: parseFloat(quantidade_comprar.toFixed(4)),
                        custo_estimado: parseFloat((quantidade_comprar * item.custo_unitario).toFixed(2)),
                        status_estoque
                    };
                })
                .filter((i) => i.quantidade_comprar > 0);

            const itens_comprar = [
                ...montarLista(demandaInsumos, 'insumo'),
                ...montarLista(demandaEmbalagens, 'embalagem')
            ].sort((a, b) => a.nome.localeCompare(b.nome));

            const custo_total_estimado = itens_comprar.reduce((s, i) => s + i.custo_estimado, 0);

            res.json({
                margem_aplicada: margem,
                ops_na_fila: detalheOps.length,
                detalhe_ops: detalheOps,
                avisos,
                itens_comprar,
                custo_total_estimado
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 7. LISTAR COLABORADORES DA EQUIPE
    listarColaboradores: async (req, res) => {
        try {
            const team = await pool.query('SELECT * FROM colaborador WHERE ativo = TRUE ORDER BY nome ASC');
            res.json(team.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 8. LISTAR ORDENS PROGRAMADAS PARA HOJE
    listarProgramadasHoje: async (req, res) => {
        try {
            const data = req.query.data || new Date().toISOString().split('T')[0];
            const ops = await pool.query(`
                SELECT op.id AS op_id, op.produto_id, p.nome AS produto,
                       op.quantidade_planejada, op.status, op.data_programada,
                       c.nome AS colaborador_nome, c.meta_diaria_individual,
                       p.peso_produtividade
                FROM ordem_producao op
                JOIN produto p ON op.produto_id = p.id
                LEFT JOIN colaborador c ON op.colaborador_id = c.id
                WHERE op.data_programada = $1
                ORDER BY op.id ASC
            `, [data]);
            res.json(ops.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 9. AGENDAR INDIVIDUALMENTE UMA OP (PUT)
    agendarOP: async (req, res) => {
        try {
            const { id } = req.params;
            const { data_programada, colaborador_id } = req.body;

            const result = await pool.query(
                `UPDATE ordem_producao
                 SET data_programada = $1, colaborador_id = $2
                 WHERE id = $3 RETURNING *`,
                [data_programada || null, colaborador_id || null, id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'OP não encontrada.' });
            }

            const op = result.rows[0];
            if (op.tipo_op === 'MONTAGEM' && data_programada) {
                const filhas = await pool.query(
                    `SELECT id FROM ordem_producao WHERE parent_op_id = $1 AND tipo_op = 'PREPARO'`,
                    [id]
                );
                if (filhas.rows.length === 0) {
                    await explodirEPrefabricarOPs(pool, id, op.produto_id, op.quantidade_planejada);
                }

                // Aplicar Inteligência de Cronograma: Recheios/Molhos em D-1, Massas em D+0
                const filhasOPs = await pool.query(
                    `SELECT op.id, r.categoria FROM ordem_producao op
                     LEFT JOIN receita r ON r.id = op.receita_id
                     WHERE op.parent_op_id = $1 AND op.tipo_op = 'PREPARO'`,
                    [id]
                );
                for (const f of filhasOPs.rows) {
                    if (f.categoria === 'Recheio' || f.categoria === 'Molho') {
                        const dateObj = new Date(data_programada + 'T00:00:00');
                        dateObj.setDate(dateObj.getDate() - 1);
                        const dateStrMinus1 = dateObj.toISOString().split('T')[0];
                        await pool.query(
                            `UPDATE ordem_producao SET data_programada = $1 WHERE id = $2`,
                            [dateStrMinus1, f.id]
                        );
                    } else {
                        await pool.query(
                            `UPDATE ordem_producao SET data_programada = $1 WHERE id = $2`,
                            [data_programada, f.id]
                        );
                    }
                }
            }

            res.json({ status: 'sucesso', op: result.rows[0] });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 10. ATUALIZAR STATUS DE UMA OP
    atualizarStatusOP: async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || isNaN(id)) {
                return res.status(400).json({ status: 'erro', erro: 'ID da OP inválido' });
            }

            const { status } = req.body;

            if (!status) {
                return res.status(400).json({ status: 'erro', erro: 'Status é obrigatório' });
            }

            const opRes = await pool.query('SELECT * FROM ordem_producao WHERE id = $1', [id]);
            if (opRes.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'OP não encontrada' });
            }

            const result = await pool.query(
                `UPDATE ordem_producao SET status = $1, 
                 data_inicio = CASE WHEN CAST($1 AS VARCHAR) = 'PRODUZINDO' AND data_inicio IS NULL THEN CURRENT_TIMESTAMP ELSE data_inicio END,
                 data_fim = CASE WHEN CAST($1 AS VARCHAR) = 'CONCLUIDA' THEN CURRENT_TIMESTAMP ELSE data_fim END
                 WHERE id = $2 RETURNING *`,
                [status, id]
            );

            res.json({ status: 'sucesso', op: result.rows[0] });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 11. INICIAR OP (FILA -> PRODUZINDO)
    iniciarOP: async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || isNaN(id)) {
                return res.status(400).json({ status: 'erro', erro: 'ID da OP inválido' });
            }

            const result = await pool.query(
                `UPDATE ordem_producao 
                 SET status = 'PRODUZINDO',
                     data_inicio = COALESCE(data_inicio, CURRENT_TIMESTAMP)
                 WHERE id = $1 RETURNING *`,
                [id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'OP não encontrada' });
            }

            res.json({ status: 'sucesso', mensagem: 'Produção iniciada!', op: result.rows[0] });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 12. FINALIZAR OP E ENVIAR PARA CÂMARA FRIA (TRANSAÇÃO SQL QUE INCREMENTA ESTOQUE)
    finalizarOP: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            if (!id || isNaN(id)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'ID da OP inválido' });
            }

            const opRes = await client.query(
                `SELECT id, produto_id, quantidade_planejada, status, tipo_op, receita_id FROM ordem_producao WHERE id = $1 FOR UPDATE`,
                [id]
            );

            if (opRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'OP não encontrada' });
            }

            const op = opRes.rows[0];

            if (op.status === 'CONCLUIDA') {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Esta OP já foi finalizada anteriormente.' });
            }

            const qtdPlanejada = parseFloat(op.quantidade_planejada || 0);

            // 1. LÓGICA SE FOR OP DE PREPARO (EX: RECHEIO OU MASSA)
            if (op.tipo_op === 'PREPARO' && op.receita_id) {
                const recRes = await client.query('SELECT peso_total FROM receita WHERE id = $1', [op.receita_id]);
                const pesoTotalReceita = parseFloat(recRes.rows[0]?.peso_total || 10.0);
                const scaleFactor = pesoTotalReceita > 0 ? (qtdPlanejada / pesoTotalReceita) : 1.0;

                const items = await client.query('SELECT * FROM receita_item WHERE receita_id = $1', [op.receita_id]);

                for (const item of items.rows) {
                    if (item.tipo_origem === 'materia') {
                        // Subtrai quantidade em kg (gramas / 1000 * fator de escala)
                        const qtdKg = (parseFloat(item.quantidade_gramas || 0) / 1000.0) * scaleFactor;
                        await client.query(
                            `UPDATE insumo SET estoque_atual = COALESCE(estoque_atual, 0) - $1 WHERE id = $2`,
                            [qtdKg, item.origem_id]
                        );
                    } else if (item.tipo_origem === 'receita') {
                        const qtdSubKg = (parseFloat(item.quantidade_gramas || 0) / 1000.0) * scaleFactor;
                        await client.query(
                            `UPDATE receita SET estoque_atual = COALESCE(estoque_atual, 0) - $1 WHERE id = $2`,
                            [qtdSubKg, item.origem_id]
                        );
                    }
                }

                // Credita o estoque produzido na tabela RECEITA
                await client.query(
                    `UPDATE receita SET estoque_atual = COALESCE(estoque_atual, 0) + $1 WHERE id = $2`,
                    [qtdPlanejada, op.receita_id]
                );
            } 
            // 2. LÓGICA SE FOR OP DE MONTAGEM (EX: COXINHA OU PRODUTO FINAL)
            else {
                // Subtrai peso das receitas vinculadas na ficha técnica do produto
                const receitasFt = await client.query(
                    `SELECT receita_id, quantidade_necessaria FROM ficha_tecnica_receita WHERE produto_id = $1`,
                    [op.produto_id]
                );

                for (const r of receitasFt.rows) {
                    const pesoKgNecessario = parseFloat(r.quantidade_necessaria || 0) * qtdPlanejada;
                    await client.query(
                        `UPDATE receita SET estoque_atual = GREATEST(0, COALESCE(estoque_atual, 0) - $1) WHERE id = $2`,
                        [pesoKgNecessario, r.receita_id]
                    );
                }

                // Subtrai insumos diretos da ficha técnica (se houver)
                try {
                    const insumosFt = await client.query(
                        `SELECT insumo_id, quantidade FROM ficha_tecnica_insumo WHERE produto_id = $1`,
                        [op.produto_id]
                    );
                    for (const ins of insumosFt.rows) {
                        const qtdUsada = parseFloat(ins.quantidade || 0) * qtdPlanejada;
                        await client.query(
                            `UPDATE insumo SET estoque_atual = COALESCE(estoque_atual, 0) - $1 WHERE id = $2`,
                            [qtdUsada, ins.insumo_id]
                        );
                    }
                } catch {
                    // tabela ficha_tecnica_insumo pode não existir em alguns ambientes
                }

                // Subtrai embalagem se configurada no produto
                const prodInfo = await client.query(
                    `SELECT embalagem_id, capacidade_embalagem FROM produto WHERE id = $1`,
                    [op.produto_id]
                );
                if (prodInfo.rows.length > 0 && prodInfo.rows[0].embalagem_id) {
                    const embId = prodInfo.rows[0].embalagem_id;
                    const cap   = parseFloat(prodInfo.rows[0].capacidade_embalagem || 1);
                    const qtdCaixas = Math.ceil(qtdPlanejada / cap);
                    await client.query(
                        `UPDATE insumo SET estoque_atual = COALESCE(estoque_atual, 0) - $1 WHERE id = $2`,
                        [qtdCaixas, embId]
                    );
                }

                // Credita o estoque do PRODUTO final
                await client.query(
                    `UPDATE produto SET estoque_atual = COALESCE(estoque_atual, 0) + $1 WHERE id = $2`,
                    [qtdPlanejada, op.produto_id]
                );
            }

            // Atualizar status da OP para CONCLUIDA
            const updatedOp = await client.query(
                `UPDATE ordem_producao 
                 SET status = 'CONCLUIDA', data_fim = CURRENT_TIMESTAMP 
                 WHERE id = $1 RETURNING *`,
                [id]
            );

            await client.query('COMMIT');

            res.json({
                status: 'sucesso',
                mensagem: 'OP finalizada com baixa de insumos/receitas e estoque creditado com sucesso!',
                op: updatedOp.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    }
};

module.exports = producaoController;
