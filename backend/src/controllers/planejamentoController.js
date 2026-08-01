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
                insumosAcumulados[item.origem_id] = 0;
            }
            insumosAcumulados[item.origem_id] += qtdKg;
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

const planejamentoController = {
    // 1. GERAR SUGESTAO SEMANAL DE PRODUÇÃO
    gerarSugestaoSemanal: async (req, res) => {
        try {
            // Seleciona pedidos ativos ('CRIADO') e seus itens
            const result = await pool.query(`
                SELECT ip.produto_id, p.nome AS produto_nome, p.categoria, 
                       SUM(ip.quantidade)::int AS total_pedido, 
                       COALESCE(p.estoque_atual, 0) AS estoque_camara
                FROM item_pedido ip
                JOIN pedido ped ON ped.id = ip.pedido_id
                JOIN produto p ON p.id = ip.produto_id
                WHERE ped.status = 'CRIADO'
                GROUP BY ip.produto_id, p.nome, p.categoria, p.estoque_atual
                ORDER BY p.nome ASC
            `);

            const sugestao = {
                'Segunda-feira': [],
                'Terça-feira': [],
                'Quarta-feira': [],
                'Quinta-feira': [],
                'Sexta-feira': [],
                'Sábado': []
            };

            for (const row of result.rows) {
                const totalPedido = row.total_pedido;
                const estoqueCamara = row.estoque_camara;
                const falta = totalPedido - estoqueCamara;
                
                if (falta <= 0) continue; // Já temos estoque suficiente na Câmara Fria

                const cat = (row.categoria || 'Geral').trim().toLowerCase();

                if (cat.includes('fermentad')) {
                    // Segunda-feira: Todos os Fermentados
                    sugestao['Segunda-feira'].push({
                        produto_id: row.produto_id,
                        produto_nome: row.produto_nome,
                        quantidade: falta,
                        categoria: row.categoria
                    });
                } else if (cat.includes('assad')) {
                    // Terça e Quinta: Assados (split 50/50)
                    const metade1 = Math.ceil(falta / 2);
                    const metade2 = falta - metade1;
                    if (metade1 > 0) {
                        sugestao['Terça-feira'].push({
                            produto_id: row.produto_id,
                            produto_nome: row.produto_nome,
                            quantidade: metade1,
                            categoria: row.categoria
                        });
                    }
                    if (metade2 > 0) {
                        sugestao['Quinta-feira'].push({
                            produto_id: row.produto_id,
                            produto_nome: row.produto_nome,
                            quantidade: metade2,
                            categoria: row.categoria
                        });
                    }
                } else if (cat.includes('frit')) {
                    // Quarta e Sexta: Fritos (split 50/50)
                    const metade1 = Math.ceil(falta / 2);
                    const metade2 = falta - metade1;
                    if (metade1 > 0) {
                        sugestao['Quarta-feira'].push({
                            produto_id: row.produto_id,
                            produto_nome: row.produto_nome,
                            quantidade: metade1,
                            categoria: row.categoria
                        });
                    }
                    if (metade2 > 0) {
                        sugestao['Sexta-feira'].push({
                            produto_id: row.produto_id,
                            produto_nome: row.produto_nome,
                            quantidade: metade2,
                            categoria: row.categoria
                        });
                    }
                } else {
                    // Fallback para Sábado (ou outro dia)
                    sugestao['Sábado'].push({
                        produto_id: row.produto_id,
                        produto_nome: row.produto_nome,
                        quantidade: falta,
                        categoria: row.categoria
                    });
                }
            }

            res.json({
                status: 'sucesso',
                sugestao
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2. VALIDAR CAPACIDADE DO COLABORADOR
    validarCapacidade: async (req, res) => {
        try {
            const { colaborador_id, data_programada, ops } = req.body; 
            // ops deve ser array de { produto_id, quantidade_planejada } ou { op_id }

            if (!colaborador_id || !data_programada) {
                return res.status(400).json({ status: 'erro', erro: 'colaborador_id e data_programada são obrigatórios' });
            }

            // Buscar a meta individual do colaborador
            const colaborador = await pool.query(
                'SELECT nome, meta_diaria_individual FROM colaborador WHERE id = $1 AND ativo = TRUE',
                [colaborador_id]
            );

            if (colaborador.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado ou inativo' });
            }

            const metaDiariaIndividual = colaborador.rows[0].meta_diaria_individual;

            // Pontuação atual programada
            const opsExistentes = await pool.query(`
                SELECT SUM(op.quantidade_planejada * COALESCE(p.peso_produtividade, 1.0)) as total_planejado
                FROM ordem_producao op
                JOIN produto p ON p.id = op.produto_id
                WHERE op.colaborador_id = $1
                AND op.data_programada = $2
                AND op.status != 'CONCLUIDA'
            `, [colaborador_id, data_programada]);

            const totalPlanejado = parseFloat(opsExistentes.rows[0].total_planejado || 0);

            // Calcular pontos da proposta
            let totalNovasOps = 0;
            if (ops && Array.isArray(ops)) {
                for (const item of ops) {
                    if (item.op_id) {
                        const opRow = await pool.query(`
                            SELECT op.quantidade_planejada, COALESCE(p.peso_produtividade, 1.0) as peso_produtividade
                            FROM ordem_producao op
                            JOIN produto p ON p.id = op.produto_id
                            WHERE op.id = $1
                        `, [item.op_id]);
                        if (opRow.rows.length > 0) {
                            totalNovasOps += opRow.rows[0].quantidade_planejada * parseFloat(opRow.rows[0].peso_produtividade);
                        }
                    } else if (item.produto_id && item.quantidade_planejada) {
                        const prodRow = await pool.query(
                            'SELECT COALESCE(peso_produtividade, 1.0) as peso_produtividade FROM produto WHERE id = $1',
                            [item.produto_id]
                        );
                        if (prodRow.rows.length > 0) {
                            totalNovasOps += parseInt(item.quantidade_planejada, 10) * parseFloat(prodRow.rows[0].peso_produtividade);
                        }
                    }
                }
            }

            const novoTotal = totalPlanejado + totalNovasOps;
            const ultrapassaMeta = novoTotal > metaDiariaIndividual;

            res.json({
                status: 'sucesso',
                colaborador: colaborador.rows[0].nome,
                meta_diaria_individual: metaDiariaIndividual,
                capacidade_atual_pontos: totalPlanejado,
                proposta_pontos: totalNovasOps,
                novo_total_pontos: novoTotal,
                capacidade_restante_pontos: Math.max(0, metaDiariaIndividual - totalPlanejado),
                ultrapassa_meta: ultrapassaMeta,
                aviso: ultrapassaMeta 
                    ? `⚠️ ALERTA: Capacidade diária ultrapassada em ${(novoTotal - metaDiariaIndividual).toFixed(1)} pontos.` 
                    : null
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. OBTER INSUMOS NECESSÁRIOS PARA A SEMANA (MRP SEMANAL)
    obterInsumosSemana: async (req, res) => {
        try {
            const { data_inicio, data_fim } = req.query;

            if (!data_inicio || !data_fim) {
                return res.status(400).json({ status: 'erro', erro: 'data_inicio e data_fim (formato YYYY-MM-DD) são obrigatórios' });
            }

            // 1. Obter todas as OPs agendadas no período e que não estão concluídas
            const opsRes = await pool.query(
                `SELECT id, produto_id, quantidade_planejada 
                 FROM ordem_producao 
                 WHERE data_programada >= $1 AND data_programada <= $2
                 AND status != 'CONCLUIDA'`,
                [data_inicio, data_fim]
            );

            const demandasInsumos = {};
            const demandasEmbalagens = {};

            for (const op of opsRes.rows) {
                const qtd = op.quantidade_planejada;

                // Ficha técnica insumos diretos
                const insumos = await pool.query(
                    `SELECT insumo_id, quantidade FROM ficha_tecnica_insumo WHERE produto_id = $1`,
                    [op.produto_id]
                );
                for (const ins of insumos.rows) {
                    if (!demandasInsumos[ins.insumo_id]) {
                        demandasInsumos[ins.insumo_id] = 0;
                    }
                    demandasInsumos[ins.insumo_id] += parseFloat(ins.quantidade) * qtd;
                }

                // Ficha técnica receitas (explosão recursiva)
                const receitas = await pool.query(
                    `SELECT receita_id, quantidade_necessaria FROM ficha_tecnica_receita WHERE produto_id = $1`,
                    [op.produto_id]
                );
                for (const rec of receitas.rows) {
                    const pesoReceitaKg = parseFloat(rec.quantidade_necessaria) * qtd;
                    const acumulador = {};
                    await explodirReceitaRec(pool, rec.receita_id, pesoReceitaKg, acumulador);

                    for (const insumoId of Object.keys(acumulador)) {
                        if (!demandasInsumos[insumoId]) {
                            demandasInsumos[insumoId] = 0;
                        }
                        demandasInsumos[insumoId] += acumulador[insumoId];
                    }
                }

                // Ficha técnica embalagens
                const embalagens = await pool.query(
                    `SELECT embalagem_id, quantidade FROM ficha_tecnica_embalagem WHERE produto_id = $1`,
                    [op.produto_id]
                );
                for (const emb of embalagens.rows) {
                    if (!demandasEmbalagens[emb.embalagem_id]) {
                        demandasEmbalagens[emb.embalagem_id] = 0;
                    }
                    demandasEmbalagens[emb.embalagem_id] += parseFloat(emb.quantidade) * qtd;
                }
            }

            const itens = [];

            // Buscar informações completas de insumos demandados
            if (Object.keys(demandasInsumos).length > 0) {
                const ids = Object.keys(demandasInsumos).map(Number);
                const insumosInfo = await pool.query(
                    `SELECT id, nome, estoque_atual, unidade_medida FROM insumo WHERE id = ANY($1) ORDER BY nome ASC`,
                    [ids]
                );
                for (const r of insumosInfo.rows) {
                    const demanda = demandasInsumos[r.id];
                    const estoque = parseFloat(r.estoque_atual || 0);
                    const falta = Math.max(0, demanda - estoque);
                    itens.push({
                        tipo: 'insumo',
                        id: r.id,
                        nome: r.nome,
                        unidade: r.unidade_medida,
                        demanda: parseFloat(demanda.toFixed(4)),
                        estoque_atual: estoque,
                        falta: parseFloat(falta.toFixed(4)),
                        comprar_urgente: falta > 0
                    });
                }
            }

            // Buscar informações completas de embalagens demandadas
            if (Object.keys(demandasEmbalagens).length > 0) {
                const ids = Object.keys(demandasEmbalagens).map(Number);
                const embalagensInfo = await pool.query(
                    `SELECT id, nome, estoque_atual FROM embalagem WHERE id = ANY($1) ORDER BY nome ASC`,
                    [ids]
                );
                for (const r of embalagensInfo.rows) {
                    const demanda = demandasEmbalagens[r.id];
                    const estoque = parseInt(r.estoque_atual || 0, 10);
                    const falta = Math.max(0, demanda - estoque);
                    itens.push({
                        tipo: 'embalagem',
                        id: r.id,
                        nome: r.nome,
                        unidade: 'un',
                        demanda: parseFloat(demanda.toFixed(4)),
                        estoque_atual: estoque,
                        falta: parseFloat(falta.toFixed(4)),
                        comprar_urgente: falta > 0
                    });
                }
            }

            res.json({
                data_inicio,
                data_fim,
                itens
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 4. APLICAR SUGESTÕES AUTOMÁTICAS E GERAR/AGENDAR OPS
    aplicarSugestao: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { atribuicoes } = req.body; // Array de { produto_id, quantidade, data_programada }

            if (!atribuicoes || !Array.isArray(atribuicoes)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'atribuicoes (array) é obrigatório' });
            }

            const opsCriadas = [];

            for (const item of atribuicoes) {
                const { produto_id, quantidade, data_programada } = item;
                if (!produto_id || !quantidade || !data_programada) continue;

                // Obter a categoria do produto
                const prodRow = await client.query('SELECT categoria FROM produto WHERE id = $1', [produto_id]);
                const categoria = prodRow.rows.length > 0 ? prodRow.rows[0].categoria : 'Geral';

                // 1. Procurar OPs com status = 'FILA' na fila que não estão programadas para este produto
                // e diminuir a fila. Deletamos as OPs pendentes da fila para evitar duplicidade.
                let restanteAgendar = quantidade;
                
                const opsFila = await client.query(
                    `SELECT id, quantidade_planejada FROM ordem_producao 
                     WHERE produto_id = $1 AND status = 'FILA' AND data_programada IS NULL 
                     ORDER BY criado_em ASC`,
                    [produto_id]
                );

                for (const op of opsFila.rows) {
                    if (restanteAgendar <= 0) break;
                    if (op.quantidade_planejada <= restanteAgendar) {
                        restanteAgendar -= op.quantidade_planejada;
                        await client.query('DELETE FROM ordem_producao WHERE id = $1', [op.id]);
                    } else {
                        // Reduzir a quantidade da OP restante na fila
                        const novaQtdFila = op.quantidade_planejada - restanteAgendar;
                        await client.query('UPDATE ordem_producao SET quantidade_planejada = $1 WHERE id = $2', [novaQtdFila, op.id]);
                        restanteAgendar = 0;
                    }
                }

                // 2. Criar a OP agendada
                const novaOp = await client.query(`
                    INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, data_programada, categoria_producao, tipo_op)
                    VALUES ($1, $2, 'FILA', $3, $4, 'MONTAGEM') RETURNING *
                `, [produto_id, quantidade, data_programada, categoria]);

                const montagemOpId = novaOp.rows[0].id;
                await explodirEPrefabricarOPs(client, montagemOpId, produto_id, quantidade);

                opsCriadas.push(novaOp.rows[0]);
            }

            await client.query('COMMIT');
            res.json({
                status: 'sucesso',
                mensagem: 'Sugestão de planejamento aplicada com sucesso.',
                ops_criadas: opsCriadas
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 5. DIVIDIR OP EM DUAS (SOBRECARGA / RESTANTE)
    splitOP: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { 
                op_id, 
                quantidade_colaborador_1, 
                colaborador_1_id, 
                data_1, 
                quantidade_colaborador_2, 
                colaborador_2_id, 
                data_2 
            } = req.body;

            const targetOpId = op_id;
            const qtd1 = parseFloat(quantidade_colaborador_1);
            const qtd2 = parseFloat(quantidade_colaborador_2);

            if (!targetOpId || isNaN(qtd1) || isNaN(qtd2) || qtd1 <= 0 || qtd2 <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Quantidades válidas são obrigatórias para a divisão.' });
            }

            // Buscar OP original
            const opRow = await client.query('SELECT * FROM ordem_producao WHERE id = $1', [targetOpId]);
            if (opRow.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'OP original não encontrada' });
            }
            const originalOp = opRow.rows[0];

            // Atualizar a OP original com a quantidade reduzida
            await client.query(
                `UPDATE ordem_producao 
                 SET quantidade_planejada = $1,
                     colaborador_id = CASE WHEN $2::int IS NOT NULL THEN $2::int ELSE colaborador_id END,
                     data_programada = CASE WHEN $3::date IS NOT NULL THEN $3::date ELSE data_programada END
                 WHERE id = $4`,
                [qtd1, colaborador_1_id || null, data_1 || null, targetOpId]
            );

            // Criar a nova OP com a quantidade restante
            let novaOp = null;
            if (qtd2 > 0) {
                novaOp = await client.query(
                    `INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, colaborador_id, data_programada, categoria_producao, tipo_op, receita_id, parent_op_id)
                     VALUES ($1, $2, 'FILA', $3, $4, $5, $6, $7, $8) RETURNING *`,
                    [
                        originalOp.produto_id, 
                        qtd2, 
                        colaborador_2_id || null, 
                        data_2 || null, 
                        originalOp.categoria_producao,
                        originalOp.tipo_op || 'MONTAGEM',
                        originalOp.receita_id || null,
                        originalOp.parent_op_id || null
                    ]
                );
            }

            await client.query('COMMIT');
            res.json({
                status: 'sucesso',
                mensagem: 'OP dividida com sucesso em duas ordens menores.',
                op_original_atualizada_id: targetOpId,
                nova_op_criada: novaOp ? novaOp.rows[0] : null
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 6. RETORNAR TODAS AS OPS PROGRAMADAS NA SEMANA ATUAL AGRUPADAS POR DIA E COLABORADOR
    obterPlanejamentoSemanal: async (req, res) => {
        try {
            let { data_inicio, data_fim } = req.query;

            if (!data_inicio || !data_fim) {
                const hoje = new Date();
                const diaSem = hoje.getDay();
                const diffSeg = hoje.getDate() - diaSem + (diaSem === 0 ? -6 : 1);
                
                const seg = new Date(hoje.setDate(diffSeg));
                const sex = new Date(seg);
                sex.setDate(seg.getDate() + 4);

                data_inicio = seg.toISOString().split('T')[0];
                data_fim = sex.toISOString().split('T')[0];
            }

            // 1. Obter todos os colaboradores ativos
            const colabsResult = await pool.query(
                "SELECT id, nome, COALESCE(meta_diaria_individual, meta_diaria, 350) AS meta_diaria_individual, eh_novato FROM colaborador WHERE status = 'Ativo' OR status IS NULL ORDER BY nome ASC"
            );
            const colaboradores = colabsResult.rows;

            // 2. Obter OPs no intervalo agendadas
            const opsResult = await pool.query(`
                SELECT op.id AS op_id, op.produto_id, p.nome AS produto_nome, 
                       op.quantidade_planejada, op.status, op.data_programada,
                       op.colaborador_id, p.peso_produtividade, p.categoria_producao,
                       op.tipo_op, op.receita_id, r.nome AS receita_nome, op.parent_op_id
                FROM ordem_producao op
                JOIN produto p ON p.id = op.produto_id
                LEFT JOIN receita r ON r.id = op.receita_id
                WHERE op.data_programada >= $1 AND op.data_programada <= $2
                AND op.status IN ('FILA', 'PRODUZINDO')
                ORDER BY op.id ASC
            `, [data_inicio, data_fim]);

            // 3. Montar a resposta agrupada por dia e colaborador
            const diasNomes = ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira'];
            const datasSemana = [];
            let current = new Date(data_inicio + 'T00:00:00');
            for (let i = 0; i < 5; i++) {
                const temp = new Date(current);
                temp.setDate(current.getDate() + i);
                datasSemana.push(temp.toISOString().split('T')[0]);
            }

            const agenda = {};
            datasSemana.forEach((dStr, index) => {
                agenda[dStr] = {
                    dia_nome: diasNomes[index],
                    data: dStr,
                    colaboradores: colaboradores.map(c => ({
                        colaborador_id: c.id,
                        nome: c.nome,
                        meta_diaria_individual: c.meta_diaria_individual,
                        eh_novato: c.eh_novato,
                        total_pontos: 0.0,
                        ops: []
                    }))
                };
            });

            // Distribuir OPs
            opsResult.rows.forEach(op => {
                const dStr = op.data_programada.toISOString().split('T')[0];
                if (agenda[dStr]) {
                    const colab = agenda[dStr].colaboradores.find(c => c.colaborador_id === op.colaborador_id);
                    if (colab) {
                        const peso = parseFloat(op.peso_produtividade || 1.0);
                        colab.ops.push({
                            op_id: op.op_id,
                            produto_id: op.produto_id,
                            produto_nome: op.produto_nome,
                            quantidade_planejada: op.quantidade_planejada,
                            peso_produtividade: peso,
                            categoria_producao: op.categoria_producao || 'Geral',
                            tipo_op: op.tipo_op,
                            receita_id: op.receita_id,
                            receita_nome: op.receita_nome,
                            parent_op_id: op.parent_op_id
                        });
                        colab.total_pontos += op.quantidade_planejada * peso;
                    }
                }
            });

            // Inteligência de Cronograma (Lead Time): verificar dependências temporais D-1 para Recheios/Molhos
            for (const dStr of Object.keys(agenda)) {
                for (const colab of agenda[dStr].colaboradores) {
                    for (const op of colab.ops) {
                        if (op.tipo_op === 'MONTAGEM' && op.data_programada) {
                            const receitasExigidas = await pool.query(
                                `SELECT r.id, r.nome, r.categoria 
                                 FROM ficha_tecnica_receita ftr
                                 JOIN receita r ON r.id = ftr.receita_id
                                 WHERE ftr.produto_id = $1`,
                                [op.produto_id]
                            );

                            const recheiosMolhos = receitasExigidas.rows.filter(
                                r => r.categoria === 'Recheio' || r.categoria === 'Molho'
                            );

                            if (recheiosMolhos.length > 0) {
                                const dataX = new Date(dStr + 'T00:00:00');
                                dataX.setDate(dataX.getDate() - 1);
                                const dateStrXMinus1 = dataX.toISOString().split('T')[0];

                                for (const rec of recheiosMolhos) {
                                    const opPrepCheck = await pool.query(
                                        `SELECT id FROM ordem_producao 
                                         WHERE tipo_op = 'PREPARO' AND receita_id = $1 AND data_programada = $2`,
                                        [rec.id, dateStrXMinus1]
                                    );

                                    if (opPrepCheck.rows.length === 0) {
                                        op.alerta = 'Atenção: Recheio para esta produção ainda não foi agendado para o dia anterior';
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            res.json({
                data_inicio,
                data_fim,
                agenda
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 7. COMPARA NECESSIDADE DE INSUMOS DAS OPS AGENDADAS VS ESTOQUES (RETORNA APENAS FALTANTES)
    validarEstoqueSemana: async (req, res) => {
        try {
            let { data_inicio, data_fim } = req.query;

            if (!data_inicio || !data_fim) {
                const hoje = new Date();
                const diaSem = hoje.getDay();
                const diffSeg = hoje.getDate() - diaSem + (diaSem === 0 ? -6 : 1);
                
                const seg = new Date(hoje.setDate(diffSeg));
                const sex = new Date(seg);
                sex.setDate(seg.getDate() + 4);

                data_inicio = seg.toISOString().split('T')[0];
                data_fim = sex.toISOString().split('T')[0];
            }

            // 1. Obter todas as OPs agendadas no período
            const opsRes = await pool.query(
                `SELECT id, produto_id, quantidade_planejada 
                 FROM ordem_producao 
                 WHERE data_programada >= $1 AND data_programada <= $2
                 AND status IN ('FILA', 'PRODUZINDO')`,
                [data_inicio, data_fim]
            );

            // Se não houver OPs, retorna vazio
            if (opsRes.rows.length === 0) {
                return res.json({
                    data_inicio,
                    data_fim,
                    itens: []
                });
            }

            // 2. Explodir as receitas (insumos e embalagens)
            const demandasInsumos = {};
            const demandasEmbalagens = {};

            for (const op of opsRes.rows) {
                const qtd = op.quantidade_planejada;

                // Ficha técnica insumos diretos
                const insumos = await pool.query(
                    `SELECT insumo_id, quantidade FROM ficha_tecnica_insumo WHERE produto_id = $1`,
                    [op.produto_id]
                );
                for (const ins of insumos.rows) {
                    if (!demandasInsumos[ins.insumo_id]) {
                        demandasInsumos[ins.insumo_id] = 0;
                    }
                    demandasInsumos[ins.insumo_id] += parseFloat(ins.quantidade) * qtd;
                }

                // Ficha técnica receitas (explosão recursiva)
                const receitas = await pool.query(
                    `SELECT receita_id, quantidade_necessaria FROM ficha_tecnica_receita WHERE produto_id = $1`,
                    [op.produto_id]
                );
                for (const rec of receitas.rows) {
                    const pesoReceitaKg = parseFloat(rec.quantidade_necessaria) * qtd;
                    const acumulador = {};
                    await explodirReceitaRec(pool, rec.receita_id, pesoReceitaKg, acumulador);

                    for (const insumoId of Object.keys(acumulador)) {
                        if (!demandasInsumos[insumoId]) {
                            demandasInsumos[insumoId] = 0;
                        }
                        demandasInsumos[insumoId] += acumulador[insumoId];
                    }
                }

                // Ficha técnica embalagens
                const embalagens = await pool.query(
                    `SELECT embalagem_id, quantidade FROM ficha_tecnica_embalagem WHERE produto_id = $1`,
                    [op.produto_id]
                );
                for (const emb of embalagens.rows) {
                    if (!demandasEmbalagens[emb.embalagem_id]) {
                        demandasEmbalagens[emb.embalagem_id] = 0;
                    }
                    demandasEmbalagens[emb.embalagem_id] += parseFloat(emb.quantidade) * qtd;
                }
            }

            // 3. Buscar estoque atual dos insumos demandados
            const itensFaltantes = [];

            if (Object.keys(demandasInsumos).length > 0) {
                const ids = Object.keys(demandasInsumos).map(Number);
                const insumosInfo = await pool.query(
                    `SELECT id, nome, estoque_atual, unidade_medida FROM insumo WHERE id = ANY($1)`,
                    [ids]
                );
                for (const row of insumosInfo.rows) {
                    const demanda = demandasInsumos[row.id];
                    const estoque = parseFloat(row.estoque_atual || 0);
                    if (demanda > estoque) {
                        itensFaltantes.push({
                            id: row.id,
                            nome: row.nome,
                            tipo: 'Insumo',
                            demanda: parseFloat(demanda.toFixed(3)),
                            estoque_atual: estoque,
                            falta: parseFloat((demanda - estoque).toFixed(3)),
                            unidade: row.unidade_medida
                        });
                    }
                }
            }

            // 4. Buscar estoque atual das embalagens demandadas
            if (Object.keys(demandasEmbalagens).length > 0) {
                const ids = Object.keys(demandasEmbalagens).map(Number);
                const embalagensInfo = await pool.query(
                    `SELECT id, nome, estoque_atual FROM embalagem WHERE id = ANY($1)`,
                    [ids]
                );
                for (const row of embalagensInfo.rows) {
                    const demanda = demandasEmbalagens[row.id];
                    const estoque = parseFloat(row.estoque_atual || 0);
                    if (demanda > estoque) {
                        itensFaltantes.push({
                            id: row.id,
                            nome: row.nome,
                            tipo: 'Embalagem',
                            demanda: Math.ceil(demanda),
                            estoque_atual: estoque,
                            falta: Math.ceil(demanda - estoque),
                            unidade: 'un'
                        });
                    }
                }
            }

            res.json({
                data_inicio,
                data_fim,
                itens: itensFaltantes
            });

        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 8. GERAR DADOS DA FICHA DE TRABALHO INDIVIDUAL PARA O COLABORADOR NO DIA
    obterFichaTrabalho: async (req, res) => {
        try {
            const { colaborador_id, data } = req.params;

            if (!colaborador_id || !data) {
                return res.status(400).json({ status: 'erro', erro: 'colaborador_id e data são obrigatórios' });
            }

            // 1. Obter dados do colaborador
            const colabRes = await pool.query(
                'SELECT id, nome, meta_diaria_individual, eh_novato FROM colaborador WHERE id = $1',
                [colaborador_id]
            );
            if (colabRes.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado' });
            }
            const colaborador = colabRes.rows[0];

            // 2. Determinar dia e categoria do dia
            const dataObj = new Date(data + 'T00:00:00');
            const diaSemanaIndex = dataObj.getDay();
            const diasNomes = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
            const diaNome = diasNomes[diaSemanaIndex];
            let categoriaDia = 'Geral';
            if (diaSemanaIndex === 1) {
                categoriaDia = 'Fermentados';
            } else if (diaSemanaIndex === 2 || diaSemanaIndex === 4) {
                categoriaDia = 'Assados';
            } else if (diaSemanaIndex === 3 || diaSemanaIndex === 5) {
                categoriaDia = 'Fritos';
            }

            // 3. Obter OPs agendadas para ele no dia
            const opsRes = await pool.query(`
                SELECT op.id AS op_id, op.produto_id, p.nome AS produto_nome, 
                       op.quantidade_planejada, op.categoria_producao,
                       op.tipo_op, op.receita_id, r.nome AS receita_nome, op.parent_op_id
                FROM ordem_producao op
                JOIN produto p ON p.id = op.produto_id
                LEFT JOIN receita r ON r.id = op.receita_id
                WHERE op.colaborador_id = $1 AND op.data_programada = $2
                AND op.status IN ('FILA', 'PRODUZINDO')
                ORDER BY op.id ASC
            `, [colaborador_id, data]);

            const opsDetalhadas = [];

            for (const op of opsRes.rows) {
                if (op.tipo_op === 'PREPARO') {
                    // CÁLCULO DE PREPARO (COZINHA)
                    const recRes = await pool.query('SELECT peso_total FROM receita WHERE id = $1', [op.receita_id]);
                    const pesoTotalReceita = parseFloat(recRes.rows[0]?.peso_total || 10.0);
                    const scaleFactor = op.quantidade_planejada / pesoTotalReceita;

                    const items = await pool.query(`
                        SELECT ri.origem_id AS insumo_id, ri.nome AS insumo_nome, 
                               ri.quantidade_gramas, i.unidade_medida
                        FROM receita_item ri
                        LEFT JOIN insumo i ON i.id = ri.origem_id
                        WHERE ri.receita_id = $1
                        ORDER BY ri.nome ASC
                    `, [op.receita_id]);

                    const ingredientes = [];
                    let pesoTotalOP = 0;

                    items.rows.forEach(ri => {
                        // Converter gramas para kg para escala brutos de cozinha
                        const qtdTotalKg = (parseFloat(ri.quantidade_gramas) / 1000.0) * scaleFactor;
                        ingredientes.push({
                            insumo_id: ri.insumo_id,
                            nome: ri.insumo_nome,
                            qtd_por_unidade: parseFloat((parseFloat(ri.quantidade_gramas) / 1000.0).toFixed(4)),
                            qtd_total: parseFloat(qtdTotalKg.toFixed(3)),
                            unidade: 'kg'
                        });
                        pesoTotalOP += qtdTotalKg;
                    });

                    // Bateladas por panela (Misturadores cozinha)
                    const capPanela = 10;
                    const numPanelas = Math.floor(op.quantidade_planejada / capPanela);
                    const saldoPanela = op.quantidade_planejada % capPanela;

                    let instrucaoBatelada = '';
                    if (op.quantidade_planejada <= 0) {
                        instrucaoBatelada = 'Nenhuma quantidade de peso planejada.';
                    } else {
                        const partes = [];
                        if (numPanelas > 0) {
                            partes.push(`Fazer ${numPanelas} panela(s) de ${capPanela}kg`);
                        }
                        if (saldoPanela > 0.05) {
                            partes.push(`1 panela de ${saldoPanela.toFixed(2)}kg`);
                        }
                        instrucaoBatelada = partes.join(' + ');
                    }

                    opsDetalhadas.push({
                        op_id: op.op_id,
                        produto_nome: op.receita_nome || 'Receita de Preparo',
                        quantidade_total: op.quantidade_planejada, // em kg
                        categoria_producao: 'Preparo',
                        tipo_op: 'PREPARO',
                        peso_total_kg: op.quantidade_planejada,
                        instrucao_batelada: instrucaoBatelada,
                        ingredientes
                    });

                } else {
                    // CÁLCULO DE MONTAGEM (CONFEÇÃO)
                    // Obter receitas vinculadas exigidas (Massas, Recheios, etc.)
                    const receitasExigidas = await pool.query(`
                        SELECT r.id, r.nome AS receita_nome, r.categoria, r.peso_total AS receita_peso_total,
                               f.quantidade_necessaria 
                        FROM ficha_tecnica_receita f
                        JOIN receita r ON r.id = f.receita_id
                        WHERE f.produto_id = $1
                    `, [op.produto_id]);

                    const receitasRequeridas = [];
                    for (const row of receitasExigidas.rows) {
                        const pesoTotalKg = parseFloat((parseFloat(row.quantidade_necessaria) * op.quantidade_planejada).toFixed(2));
                        const itemRec = {
                            id: row.id,
                            nome: row.receita_nome,
                            categoria: row.categoria,
                            peso_total_kg: pesoTotalKg,
                            ingredientes: []
                        };

                        if (row.categoria === 'Massa') {
                            const scaleFactor = pesoTotalKg / parseFloat(row.receita_peso_total || 10.0);
                            const items = await pool.query(`
                                SELECT ri.origem_id AS insumo_id, ri.nome AS insumo_nome, 
                                       ri.quantidade_gramas, i.unidade_medida
                                FROM receita_item ri
                                LEFT JOIN insumo i ON i.id = ri.origem_id
                                WHERE ri.receita_id = $1
                                ORDER BY ri.nome ASC
                            `, [row.id]);

                            itemRec.ingredientes = items.rows.map(ri => ({
                                nome: ri.insumo_nome,
                                qtd_total: parseFloat(((parseFloat(ri.quantidade_gramas) / 1000.0) * scaleFactor).toFixed(3)),
                                unidade: 'kg'
                            }));
                        }

                        receitasRequeridas.push(itemRec);
                    }

                    opsDetalhadas.push({
                        op_id: op.op_id,
                        produto_nome: op.produto_nome,
                        quantidade_total: op.quantidade_planejada, // em unidades
                        categoria_producao: op.categoria_producao || 'Geral',
                        tipo_op: 'MONTAGEM',
                        receitas_requeridas: receitasRequeridas
                    });
                }
            }

            res.json({
                colaborador: {
                    id: colaborador.id,
                    nome: colaborador.nome,
                    meta_diaria_individual: colaborador.meta_diaria_individual,
                    eh_novato: colaborador.eh_novato
                },
                data,
                dia_nome: diaNome,
                categoria_dia: categoriaDia,
                ops: opsDetalhadas
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 9. AGENDAR OP COM INTELIGÊNCIA DE CRONOGRAMA D-1
    agendarOP: async (req, res) => {
        try {
            const { op_id, data_programada, colaborador_id } = req.body;
            const targetId = req.params.id || op_id;

            if (!targetId) {
                return res.status(400).json({ status: 'erro', erro: 'ID da OP é obrigatório' });
            }

            const result = await pool.query(
                `UPDATE ordem_producao
                 SET data_programada = $1, colaborador_id = $2
                 WHERE id = $3 RETURNING *`,
                [data_programada || null, colaborador_id || null, targetId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'OP não encontrada.' });
            }

            const op = result.rows[0];
            let avisoCronograma = null;

            if (op.tipo_op === 'MONTAGEM' && data_programada) {
                const filhas = await pool.query(
                    `SELECT id FROM ordem_producao WHERE parent_op_id = $1 AND tipo_op = 'PREPARO'`,
                    [targetId]
                );
                if (filhas.rows.length === 0) {
                    await explodirEPrefabricarOPs(pool, targetId, op.produto_id, op.quantidade_planejada);
                }

                // Inteligência de Cronograma: Recheios/Molhos em D-1
                const filhasOPs = await pool.query(
                    `SELECT op.id, r.categoria FROM ordem_producao op
                     LEFT JOIN receita r ON r.id = op.receita_id
                     WHERE op.parent_op_id = $1 AND op.tipo_op = 'PREPARO'`,
                    [targetId]
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
                        avisoCronograma = `💡 D-1 Ativado: O recheio/molho vinculado foi agendado para o dia anterior (${dateStrMinus1}).`;
                    } else {
                        await pool.query(
                            `UPDATE ordem_producao SET data_programada = $1 WHERE id = $2`,
                            [data_programada, f.id]
                        );
                    }
                }
            }

            res.json({ status: 'sucesso', op: result.rows[0], aviso: avisoCronograma });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    }
};

module.exports = planejamentoController;
