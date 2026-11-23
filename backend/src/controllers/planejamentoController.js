const pool = require('../config/db');

function obterPesoTotalReceitaKg(rawPesoTotal, itemsRows) {
    const somaGramas = (itemsRows || []).reduce((acc, it) => acc + parseFloat(it.quantidade_gramas || 0), 0);
    const raw = parseFloat(rawPesoTotal || 0);
    if (somaGramas > 0) {
        if (Math.abs(raw - somaGramas) < 0.05) {
            return somaGramas / 1000.0;
        }
        if (raw > 0) {
            return raw;
        }
        return somaGramas / 1000.0;
    }
    return raw > 100 ? raw / 1000.0 : (raw || 10.0);
}

function formatarDataLocal(dateObj) {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function parseDataLocal(dataInput) {
    if (!dataInput) return new Date();
    if (dataInput instanceof Date) {
        return new Date(dataInput.getFullYear(), dataInput.getMonth(), dataInput.getDate());
    }
    const str = String(dataInput).split('T')[0];
    const [y, m, d] = str.split('-').map(Number);
    if (!y || !m || !d) return new Date();
    return new Date(y, m - 1, d);
}

/**
 * Calcula a semana útil (Segunda a Sexta) com virada automática no Sábado:
 * - Seg a Sex (1..5): Segunda a Sexta da semana corrente
 * - Sábado (6): próxima Segunda (+2 dias) até próxima Sexta
 * - Domingo (0): próxima Segunda (+1 dia) até próxima Sexta
 */
function calcularSemanaUtil(dataRef = new Date()) {
    const base = parseDataLocal(dataRef);
    const diaSemana = base.getDay(); // 0=Dom, 1=Seg, ..., 6=Sab
    const segunda = new Date(base.getFullYear(), base.getMonth(), base.getDate());

    if (diaSemana === 6) {
        segunda.setDate(segunda.getDate() + 2);
    } else if (diaSemana === 0) {
        segunda.setDate(segunda.getDate() + 1);
    } else {
        segunda.setDate(segunda.getDate() - (diaSemana - 1));
    }

    const sexta = new Date(segunda.getFullYear(), segunda.getMonth(), segunda.getDate() + 4);
    const datas = [];
    for (let i = 0; i < 5; i++) {
        const d = new Date(segunda.getFullYear(), segunda.getMonth(), segunda.getDate() + i);
        datas.push(formatarDataLocal(d));
    }

    return {
        data_inicio: formatarDataLocal(segunda),
        data_fim: formatarDataLocal(sexta),
        datas
    };
}

function gerarInstrucaoBatelada(pesoTotalKg, capPanela = 10) {
    const peso = parseFloat(pesoTotalKg || 0);
    if (peso <= 0) return 'Nenhuma batelada planejada.';
    const numPanelas = Math.floor(peso / capPanela);
    const saldoPanela = parseFloat((peso - numPanelas * capPanela).toFixed(3));
    const partes = [];
    if (numPanelas > 0) {
        partes.push(`${numPanelas} panela(s) de ${capPanela} kg`);
    }
    if (saldoPanela >= 0.01) {
        partes.push(`1 panela de ${saldoPanela.toFixed(2)} kg`);
    }
    return partes.join(' + ') || `1 panela de ${peso.toFixed(2)} kg`;
}

async function explodirReceitaRec(client, receitaId, pesoNecessarioKg, insumosAcumulados = {}) {
    const items = await client.query(
        'SELECT * FROM receita_item WHERE receita_id = $1',
        [receitaId]
    );
    const recRes = await client.query('SELECT peso_total FROM receita WHERE id = $1', [receitaId]);
    const pesoTotalReceita = obterPesoTotalReceitaKg(recRes.rows[0]?.peso_total, items.rows);
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

/**
 * Monta detalhes das OPs de um colaborador para Ficha de Produção (Diária ou Semanal)
 */
async function montarDetalhesOpsFicha(client, opsRows) {
    const opsDetalhadas = [];
    for (const op of opsRows) {
        const receitasExigidas = await client.query(`
            SELECT r.id, r.nome AS receita_nome, r.categoria, r.peso_total AS receita_peso_total,
                   f.quantidade_necessaria
            FROM ficha_tecnica_receita f
            JOIN receita r ON r.id = f.receita_id
            WHERE f.produto_id = $1
            ORDER BY r.categoria ASC, r.nome ASC
        `, [op.produto_id]);

        const receitasRequeridas = [];
        for (const row of receitasExigidas.rows) {
            const pesoTotalKg = parseFloat((parseFloat(row.quantidade_necessaria || 0) * op.quantidade_planejada).toFixed(3));
            receitasRequeridas.push({
                id: row.id,
                nome: row.receita_nome,
                categoria: row.categoria,
                peso_total_kg: pesoTotalKg
            });
        }

        opsDetalhadas.push({
            op_id: op.op_id,
            produto_id: op.produto_id,
            produto_nome: op.produto_nome,
            quantidade_total: op.quantidade_planejada,
            status: op.status,
            data_programada: op.data_programada,
            categoria_producao: op.categoria_producao || 'Geral',
            tipo_op: 'MONTAGEM',
            pedido_id: op.pedido_id,
            agrupada: Boolean(op.agrupada),
            cliente_nome: op.cliente_nome || null,
            data_entrega: op.data_entrega || null,
            origens: op.origens || [],
            receitas_requeridas: receitasRequeridas
        });
    }
    return opsDetalhadas;
}

const planejamentoController = {
    calcularSemanaUtil,

    // 1. GERAR SUGESTAO SEMANAL DE PRODUÇÃO
    gerarSugestaoSemanal: async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT ip.produto_id, p.nome AS produto_nome, p.categoria, 
                       SUM(ip.quantidade)::int AS total_pedido, 
                       COALESCE(p.estoque_atual, 0) AS estoque_camara
                FROM item_pedido ip
                JOIN pedido ped ON ped.id = ip.pedido_id
                JOIN produto p ON p.id = ip.produto_id
                WHERE ped.status = 'ABERTO' AND ped.estoque_baixado = FALSE
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
                if (falta <= 0) continue;

                const cat = (row.categoria || 'Geral').trim().toLowerCase();

                if (cat.includes('fermentad')) {
                    sugestao['Segunda-feira'].push({
                        produto_id: row.produto_id,
                        produto_nome: row.produto_nome,
                        quantidade: falta,
                        categoria: row.categoria
                    });
                } else if (cat.includes('assad')) {
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

    // 2. VALIDAR CAPACIDADE DO COLABORADOR EM UNIDADES SIMPLES
    validarCapacidade: async (req, res) => {
        try {
            const { colaborador_id, data_programada, ops } = req.body;

            if (!colaborador_id || !data_programada) {
                return res.status(400).json({ status: 'erro', erro: 'colaborador_id e data_programada são obrigatórios' });
            }

            const colaborador = await pool.query(
                'SELECT nome, COALESCE(meta_diaria_individual, meta_diaria, 350) AS meta_diaria_individual FROM colaborador WHERE id = $1 AND ativo = TRUE',
                [colaborador_id]
            );

            if (colaborador.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado ou inativo' });
            }

            const metaDiariaIndividual = parseInt(colaborador.rows[0].meta_diaria_individual, 10) || 350;

            // Unidades atuais programadas no dia (sem multiplicar por peso_produtividade)
            const opsExistentes = await pool.query(`
                SELECT COALESCE(SUM(op.quantidade_planejada), 0)::int AS total_planejado
                FROM ordem_producao op
                WHERE op.colaborador_id = $1
                AND op.data_programada = $2
                AND op.status != 'CONCLUIDA'
                AND COALESCE(op.tipo_op, 'MONTAGEM') = 'MONTAGEM'
            `, [colaborador_id, data_programada]);

            const totalPlanejado = parseInt(opsExistentes.rows[0].total_planejado || 0, 10);

            let totalNovasOps = 0;
            if (ops && Array.isArray(ops)) {
                for (const item of ops) {
                    if (item.op_id) {
                        const opRow = await pool.query(
                            'SELECT quantidade_planejada FROM ordem_producao WHERE id = $1',
                            [item.op_id]
                        );
                        if (opRow.rows.length > 0) {
                            totalNovasOps += parseInt(opRow.rows[0].quantidade_planejada, 10) || 0;
                        }
                    } else if (item.quantidade_planejada) {
                        totalNovasOps += parseInt(item.quantidade_planejada, 10) || 0;
                    }
                }
            }

            const novoTotal = totalPlanejado + totalNovasOps;
            const ultrapassaMeta = novoTotal > metaDiariaIndividual;

            res.json({
                status: 'sucesso',
                colaborador: colaborador.rows[0].nome,
                meta_diaria_individual: metaDiariaIndividual,
                capacidade_atual_unidades: totalPlanejado,
                proposta_unidades: totalNovasOps,
                novo_total_unidades: novoTotal,
                capacidade_restante_unidades: Math.max(0, metaDiariaIndividual - totalPlanejado),
                capacidade_atual_pontos: totalPlanejado,
                proposta_pontos: totalNovasOps,
                novo_total_pontos: novoTotal,
                capacidade_restante_pontos: Math.max(0, metaDiariaIndividual - totalPlanejado),
                ultrapassa_meta: ultrapassaMeta,
                aviso: ultrapassaMeta
                    ? `⚠️ ALERTA: Capacidade diária ultrapassada em ${novoTotal - metaDiariaIndividual} un (${novoTotal}/${metaDiariaIndividual} un).`
                    : null
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. OBTER INSUMOS NECESSÁRIOS PARA A SEMANA (MRP SEMANAL)
    obterInsumosSemana: async (req, res) => {
        try {
            let { data_inicio, data_fim } = req.query;

            if (!data_inicio || !data_fim) {
                const sem = calcularSemanaUtil();
                data_inicio = sem.data_inicio;
                data_fim = sem.data_fim;
            }

            const opsRes = await pool.query(
                `SELECT id, produto_id, quantidade_planejada 
                 FROM ordem_producao 
                 WHERE data_programada >= $1 AND data_programada <= $2
                 AND status != 'CONCLUIDA'
                 AND COALESCE(tipo_op, 'MONTAGEM') = 'MONTAGEM'`,
                [data_inicio, data_fim]
            );

            const demandasInsumos = {};
            const demandasEmbalagens = {};

            for (const op of opsRes.rows) {
                const qtd = op.quantidade_planejada;

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

    // 4. APLICAR SUGESTÕES AUTOMÁTICAS E GERAR/AGENDAR OPS (APENAS MONTAGEM)
    aplicarSugestao: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { atribuicoes } = req.body;

            if (!atribuicoes || !Array.isArray(atribuicoes)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'atribuicoes (array) é obrigatório' });
            }

            const opsCriadas = [];

            for (const item of atribuicoes) {
                const { produto_id, quantidade, data_programada, colaborador_id } = item;
                if (!produto_id || !quantidade || !data_programada) continue;

                const prodRow = await client.query('SELECT categoria, categoria_producao FROM produto WHERE id = $1', [produto_id]);
                const categoria = prodRow.rows.length > 0 ? (prodRow.rows[0].categoria_producao || prodRow.rows[0].categoria || 'Geral') : 'Geral';

                let restanteAgendar = quantidade;

                const opsFila = await client.query(
                    `SELECT id, quantidade_planejada FROM ordem_producao 
                     WHERE produto_id = $1 AND status = 'FILA' AND data_programada IS NULL 
                       AND COALESCE(tipo_op, 'MONTAGEM') = 'MONTAGEM'
                     ORDER BY criado_em ASC`,
                    [produto_id]
                );

                for (const op of opsFila.rows) {
                    if (restanteAgendar <= 0) break;
                    if (op.quantidade_planejada <= restanteAgendar) {
                        restanteAgendar -= op.quantidade_planejada;
                        await client.query('DELETE FROM ordem_producao WHERE id = $1', [op.id]);
                    } else {
                        const novaQtdFila = op.quantidade_planejada - restanteAgendar;
                        await client.query('UPDATE ordem_producao SET quantidade_planejada = $1 WHERE id = $2', [novaQtdFila, op.id]);
                        restanteAgendar = 0;
                    }
                }

                const novaOp = await client.query(`
                    INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, data_programada, colaborador_id, categoria_producao, tipo_op)
                    VALUES ($1, $2, 'FILA', $3, $4, $5, 'MONTAGEM') RETURNING *
                `, [produto_id, quantidade, data_programada, colaborador_id || null, categoria]);

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
                data_2,
                quantidade_separar,
                quantidade_nova
            } = req.body;

            const targetOpId = op_id;
            if (!targetOpId) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'ID da OP é obrigatório.' });
            }

            const opRow = await client.query('SELECT * FROM ordem_producao WHERE id = $1 FOR UPDATE', [targetOpId]);
            if (opRow.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'OP original não encontrada' });
            }
            const originalOp = opRow.rows[0];
            const qtdTotalOriginal = parseFloat(originalOp.quantidade_planejada || 0);

            let qtd1, qtd2;
            const separar = parseFloat(quantidade_separar ?? quantidade_nova);
            if (!isNaN(separar) && separar > 0) {
                qtd2 = separar;
                qtd1 = qtdTotalOriginal - qtd2;
            } else {
                qtd1 = parseFloat(quantidade_colaborador_1);
                qtd2 = parseFloat(quantidade_colaborador_2);
            }

            if (isNaN(qtd1) || isNaN(qtd2) || qtd1 <= 0 || qtd2 <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: `Quantidades inválidas. A OP original tem ${qtdTotalOriginal} unidades. A quantidade a separar deve ser menor que o total.`
                });
            }

            await client.query(
                `UPDATE ordem_producao 
                 SET quantidade_planejada = $1,
                     colaborador_id = CASE WHEN $2::int IS NOT NULL THEN $2::int ELSE colaborador_id END,
                     data_programada = CASE WHEN $3::date IS NOT NULL THEN $3::date ELSE data_programada END
                 WHERE id = $4`,
                [qtd1, colaborador_1_id || null, data_1 || null, targetOpId]
            );

            const novaOp = await client.query(
                `INSERT INTO ordem_producao (
                    produto_id, quantidade_planejada, status, colaborador_id, data_programada,
                    categoria_producao, tipo_op, receita_id, parent_op_id, pedido_id, agrupada
                 )
                 VALUES ($1, $2, 'FILA', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [
                    originalOp.produto_id,
                    qtd2,
                    colaborador_2_id || null,
                    data_2 || null,
                    originalOp.categoria_producao,
                    originalOp.tipo_op || 'MONTAGEM',
                    originalOp.receita_id || null,
                    originalOp.parent_op_id || null,
                    originalOp.pedido_id || null,
                    Boolean(originalOp.agrupada)
                ]
            );

            // Distribuir vínculos de origem proporcionalmente/sequencialmente sem duplicar quantidades
            const origensRes = await client.query(
                'SELECT id, pedido_id, cliente_id, quantidade, data_entrega FROM ordem_producao_origem WHERE ordem_producao_id = $1 ORDER BY id ASC',
                [targetOpId]
            );
            if (origensRes.rows.length === 1) {
                const orig = origensRes.rows[0];
                await client.query(
                    'UPDATE ordem_producao_origem SET quantidade = $1 WHERE id = $2',
                    [Math.round(qtd1), orig.id]
                );
                await client.query(
                    `INSERT INTO ordem_producao_origem (ordem_producao_id, pedido_id, cliente_id, quantidade, data_entrega)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [novaOp.rows[0].id, orig.pedido_id, orig.cliente_id, Math.round(qtd2), orig.data_entrega]
                );
            } else if (origensRes.rows.length > 1) {
                await client.query('DELETE FROM ordem_producao_origem WHERE ordem_producao_id = $1', [targetOpId]);
                let restante1 = Math.round(qtd1);
                let restante2 = Math.round(qtd2);
                for (const orig of origensRes.rows) {
                    let qOrig = Math.max(0, parseInt(orig.quantidade, 10) || 0);
                    if (restante1 > 0 && qOrig > 0) {
                        const alocar1 = Math.min(qOrig, restante1);
                        await client.query(
                            `INSERT INTO ordem_producao_origem (ordem_producao_id, pedido_id, cliente_id, quantidade, data_entrega)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [targetOpId, orig.pedido_id, orig.cliente_id, alocar1, orig.data_entrega]
                        );
                        restante1 -= alocar1;
                        qOrig -= alocar1;
                    }
                    if (restante2 > 0 && qOrig > 0) {
                        const alocar2 = Math.min(qOrig, restante2);
                        await client.query(
                            `INSERT INTO ordem_producao_origem (ordem_producao_id, pedido_id, cliente_id, quantidade, data_entrega)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [novaOp.rows[0].id, orig.pedido_id, orig.cliente_id, alocar2, orig.data_entrega]
                        );
                        restante2 -= alocar2;
                    }
                }
            }

            await client.query('COMMIT');
            res.json({
                status: 'sucesso',
                mensagem: 'OP dividida com sucesso em duas ordens menores.',
                op_original_atualizada_id: targetOpId,
                nova_op_criada: novaOp.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 5b. AGRUPAR MANUALMENTE 2 OU MAIS OPS DO MESMO PRODUTO (POST /api/planejamento/agrupar-ops)
    agruparOPs: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { ops_ids } = req.body || {};

            if (!Array.isArray(ops_ids)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Envie ops_ids como uma lista de pelo menos 2 OPs para agrupar.'
                });
            }

            const uniqueIds = Array.from(new Set(ops_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0)));
            if (uniqueIds.length < 2) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Selecione pelo menos 2 OPs distintas para agrupar.'
                });
            }

            const opsRes = await client.query(
                `SELECT op.*, ped.cliente_id AS ped_cliente_id, ped.data_entrega AS ped_data_entrega
                 FROM ordem_producao op
                 LEFT JOIN pedido ped ON ped.id = op.pedido_id
                 WHERE op.id = ANY($1)
                 ORDER BY op.id ASC
                 FOR UPDATE OF op`,
                [uniqueIds]
            );

            if (opsRes.rows.length !== uniqueIds.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    status: 'erro',
                    erro: 'Uma ou mais OPs selecionadas não foram encontradas.'
                });
            }

            const produtoBaseId = opsRes.rows[0].produto_id;
            for (const op of opsRes.rows) {
                if (op.status !== 'FILA') {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        status: 'erro',
                        erro: `A OP #${op.id} está com status "${op.status}". Apenas OPs com status FILA podem ser agrupadas.`
                    });
                }
                if (op.produto_id !== produtoBaseId) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        status: 'erro',
                        erro: 'Só é permitido agrupar OPs que sejam do mesmo Produto Final.'
                    });
                }
            }

            const opPrincipal = opsRes.rows[0];
            const opsAbsorvidas = opsRes.rows.slice(1);
            const somaQuantidade = opsRes.rows.reduce((acc, r) => acc + parseInt(r.quantidade_planejada, 10), 0);

            for (const opAtual of opsRes.rows) {
                const origRes = await client.query(
                    'SELECT id FROM ordem_producao_origem WHERE ordem_producao_id = $1',
                    [opAtual.id]
                );
                if (origRes.rows.length > 0) {
                    if (opAtual.id !== opPrincipal.id) {
                        await client.query(
                            'UPDATE ordem_producao_origem SET ordem_producao_id = $1 WHERE ordem_producao_id = $2',
                            [opPrincipal.id, opAtual.id]
                        );
                    }
                } else {
                    await client.query(
                        `INSERT INTO ordem_producao_origem (ordem_producao_id, pedido_id, cliente_id, quantidade, data_entrega)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [
                            opPrincipal.id,
                            opAtual.pedido_id || null,
                            opAtual.ped_cliente_id || null,
                            parseInt(opAtual.quantidade_planejada, 10),
                            opAtual.ped_data_entrega || null
                        ]
                    );
                }
            }

            const updatedOp = await client.query(
                `UPDATE ordem_producao
                 SET quantidade_planejada = $1,
                     agrupada = TRUE,
                     pedido_id = NULL
                 WHERE id = $2
                 RETURNING *`,
                [somaQuantidade, opPrincipal.id]
            );

            const idsAbsorvidos = opsAbsorvidas.map(o => o.id);
            await client.query(
                'DELETE FROM ordem_producao WHERE id = ANY($1)',
                [idsAbsorvidos]
            );

            const origensFinal = await client.query(
                `SELECT opo.id, opo.pedido_id, opo.cliente_id, c.razao_social, opo.quantidade,
                        TO_CHAR(COALESCE(opo.data_entrega, p.data_entrega), 'YYYY-MM-DD') AS data_entrega
                 FROM ordem_producao_origem opo
                 LEFT JOIN cliente c ON c.id = opo.cliente_id
                 LEFT JOIN pedido p ON p.id = opo.pedido_id
                 WHERE opo.ordem_producao_id = $1
                 ORDER BY opo.id ASC`,
                [opPrincipal.id]
            );

            await client.query('COMMIT');

            res.json({
                status: 'sucesso',
                mensagem: `${opsRes.rows.length} OPs agrupadas na OP #${opPrincipal.id} (${somaQuantidade} un).`,
                op: {
                    ...updatedOp.rows[0],
                    origens: origensFinal.rows
                },
                ops_absorvidas: idsAbsorvidos
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 6. RETORNAR TODAS AS OPS PROGRAMADAS NA SEMANA AGRUPADAS POR DIA E COLABORADOR
    obterPlanejamentoSemanal: async (req, res) => {
        try {
            let { data_inicio, data_fim, data_ref } = req.query;

            if (!data_inicio || !data_fim) {
                const sem = calcularSemanaUtil(data_ref || new Date());
                data_inicio = sem.data_inicio;
                data_fim = sem.data_fim;
            }

            const colabsResult = await pool.query(
                "SELECT id, nome, COALESCE(meta_diaria_individual, meta_diaria, 350) AS meta_diaria_individual, eh_novato FROM colaborador WHERE (status = 'Ativo' OR status IS NULL) AND COALESCE(ativo, TRUE) = TRUE ORDER BY nome ASC"
            );
            const colaboradores = colabsResult.rows;

            const opsResult = await pool.query(`
                SELECT op.id AS op_id, op.produto_id, p.nome AS produto_nome, 
                       op.quantidade_planejada, op.quantidade_realizada, op.status,
                       TO_CHAR(op.data_programada, 'YYYY-MM-DD') AS data_programada,
                       op.colaborador_id, p.peso_produtividade,
                       COALESCE(op.categoria_producao, p.categoria_producao, p.categoria, 'Geral') AS categoria_producao,
                       COALESCE(op.tipo_op, 'MONTAGEM') AS tipo_op,
                       op.receita_id, r.nome AS receita_nome, op.parent_op_id,
                       op.pedido_id, COALESCE(op.agrupada, FALSE) AS agrupada,
                       TO_CHAR(ped.data_entrega, 'YYYY-MM-DD') AS data_entrega,
                       cli.razao_social AS cliente_nome,
                       COALESCE((
                           SELECT json_agg(
                               json_build_object(
                                   'id', opo.id,
                                   'pedido_id', opo.pedido_id,
                                   'cliente_id', opo.cliente_id,
                                   'razao_social', c_orig.razao_social,
                                   'quantidade', opo.quantidade,
                                   'data_entrega', TO_CHAR(COALESCE(opo.data_entrega, p_orig.data_entrega), 'YYYY-MM-DD')
                               ) ORDER BY opo.id ASC
                           )
                           FROM ordem_producao_origem opo
                           LEFT JOIN cliente c_orig ON c_orig.id = opo.cliente_id
                           LEFT JOIN pedido p_orig ON p_orig.id = opo.pedido_id
                           WHERE opo.ordem_producao_id = op.id
                       ), '[]'::json) AS origens
                FROM ordem_producao op
                JOIN produto p ON p.id = op.produto_id
                LEFT JOIN receita r ON r.id = op.receita_id
                LEFT JOIN pedido ped ON ped.id = op.pedido_id
                LEFT JOIN cliente cli ON cli.id = ped.cliente_id
                WHERE op.data_programada >= $1 AND op.data_programada <= $2
                  AND op.status IN ('FILA', 'PRODUZINDO', 'CONCLUIDA')
                  AND COALESCE(op.tipo_op, 'MONTAGEM') = 'MONTAGEM'
                ORDER BY op.id ASC
            `, [data_inicio, data_fim]);

            const diasNomes = ['Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira'];
            const datasSemana = [];
            const baseDate = parseDataLocal(data_inicio);
            for (let i = 0; i < 5; i++) {
                const temp = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + i);
                datasSemana.push(formatarDataLocal(temp));
            }

            const agenda = {};
            datasSemana.forEach((dStr, index) => {
                agenda[dStr] = {
                    dia_nome: diasNomes[index],
                    data: dStr,
                    colaboradores: colaboradores.map(c => ({
                        colaborador_id: c.id,
                        nome: c.nome,
                        meta_diaria_individual: parseInt(c.meta_diaria_individual, 10) || 350,
                        eh_novato: c.eh_novato,
                        total_unidades: 0,
                        total_pontos: 0,
                        ops: []
                    }))
                };
            });

            opsResult.rows.forEach(op => {
                const dStr = String(op.data_programada).split('T')[0];
                if (agenda[dStr]) {
                    const colab = agenda[dStr].colaboradores.find(c => c.colaborador_id === op.colaborador_id);
                    if (colab) {
                        const qtd = parseInt(op.quantidade_planejada, 10) || 0;
                        colab.ops.push({
                            op_id: op.op_id,
                            produto_id: op.produto_id,
                            produto_nome: op.produto_nome,
                            quantidade_planejada: qtd,
                            quantidade_realizada: parseInt(op.quantidade_realizada || 0, 10),
                            status: op.status,
                            data_programada: dStr,
                            colaborador_id: op.colaborador_id,
                            peso_produtividade: parseFloat(op.peso_produtividade || 1.0),
                            categoria_producao: op.categoria_producao || 'Geral',
                            tipo_op: op.tipo_op,
                            pedido_id: op.pedido_id,
                            agrupada: Boolean(op.agrupada),
                            cliente_nome: op.cliente_nome || null,
                            data_entrega: op.data_entrega || null,
                            origens: op.origens || []
                        });
                        colab.total_unidades += qtd;
                        colab.total_pontos += qtd;
                    }
                }
            });

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
                const sem = calcularSemanaUtil();
                data_inicio = sem.data_inicio;
                data_fim = sem.data_fim;
            }

            const opsRes = await pool.query(
                `SELECT id, produto_id, quantidade_planejada 
                 FROM ordem_producao 
                 WHERE data_programada >= $1 AND data_programada <= $2
                 AND status IN ('FILA', 'PRODUZINDO')
                 AND COALESCE(tipo_op, 'MONTAGEM') = 'MONTAGEM'`,
                [data_inicio, data_fim]
            );

            if (opsRes.rows.length === 0) {
                return res.json({
                    data_inicio,
                    data_fim,
                    itens: []
                });
            }

            const demandasInsumos = {};
            const demandasEmbalagens = {};

            for (const op of opsRes.rows) {
                const qtd = op.quantidade_planejada;

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

            const colabRes = await pool.query(
                'SELECT id, nome, COALESCE(meta_diaria_individual, meta_diaria, 350) AS meta_diaria_individual, eh_novato FROM colaborador WHERE id = $1',
                [colaborador_id]
            );
            if (colabRes.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado' });
            }
            const colaborador = colabRes.rows[0];

            const dataObj = parseDataLocal(data);
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

            const opsRes = await pool.query(`
                SELECT op.id AS op_id, op.produto_id, p.nome AS produto_nome, 
                       op.quantidade_planejada, op.status,
                       TO_CHAR(op.data_programada, 'YYYY-MM-DD') AS data_programada,
                       COALESCE(op.categoria_producao, p.categoria_producao, p.categoria, 'Geral') AS categoria_producao,
                       COALESCE(op.tipo_op, 'MONTAGEM') AS tipo_op,
                       op.pedido_id, COALESCE(op.agrupada, FALSE) AS agrupada,
                       TO_CHAR(ped.data_entrega, 'YYYY-MM-DD') AS data_entrega,
                       cli.razao_social AS cliente_nome,
                       COALESCE((
                           SELECT json_agg(
                               json_build_object(
                                   'id', opo.id,
                                   'pedido_id', opo.pedido_id,
                                   'cliente_id', opo.cliente_id,
                                   'razao_social', c_orig.razao_social,
                                   'quantidade', opo.quantidade,
                                   'data_entrega', TO_CHAR(COALESCE(opo.data_entrega, p_orig.data_entrega), 'YYYY-MM-DD')
                               ) ORDER BY opo.id ASC
                           )
                           FROM ordem_producao_origem opo
                           LEFT JOIN cliente c_orig ON c_orig.id = opo.cliente_id
                           LEFT JOIN pedido p_orig ON p_orig.id = opo.pedido_id
                           WHERE opo.ordem_producao_id = op.id
                       ), '[]'::json) AS origens
                FROM ordem_producao op
                JOIN produto p ON p.id = op.produto_id
                LEFT JOIN pedido ped ON ped.id = op.pedido_id
                LEFT JOIN cliente cli ON cli.id = ped.cliente_id
                WHERE op.colaborador_id = $1 AND op.data_programada = $2
                  AND op.status IN ('FILA', 'PRODUZINDO', 'CONCLUIDA')
                  AND COALESCE(op.tipo_op, 'MONTAGEM') = 'MONTAGEM'
                ORDER BY op.id ASC
            `, [colaborador_id, data]);

            const opsDetalhadas = await montarDetalhesOpsFicha(pool, opsRes.rows);
            const totalUnidades = opsDetalhadas.reduce((acc, o) => acc + (parseInt(o.quantidade_total, 10) || 0), 0);

            res.json({
                colaborador: {
                    id: colaborador.id,
                    nome: colaborador.nome,
                    meta_diaria_individual: parseInt(colaborador.meta_diaria_individual, 10) || 350,
                    eh_novato: colaborador.eh_novato
                },
                data,
                dia_nome: diaNome,
                categoria_dia: categoriaDia,
                total_unidades: totalUnidades,
                ops: opsDetalhadas
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 8b. FICHA SEMANAL DO COLABORADOR (Seg a Sex) — GET /api/planejamento/ficha-semana/:colaborador_id
    obterFichaSemana: async (req, res) => {
        try {
            const { colaborador_id } = req.params;
            let { data_inicio, data_fim } = req.query;

            if (!colaborador_id) {
                return res.status(400).json({ status: 'erro', erro: 'colaborador_id é obrigatório' });
            }

            if (!data_inicio || !data_fim) {
                const sem = calcularSemanaUtil();
                data_inicio = sem.data_inicio;
                data_fim = sem.data_fim;
            }

            const colabRes = await pool.query(
                'SELECT id, nome, COALESCE(meta_diaria_individual, meta_diaria, 350) AS meta_diaria_individual, eh_novato FROM colaborador WHERE id = $1',
                [colaborador_id]
            );
            if (colabRes.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado' });
            }
            const colaborador = colabRes.rows[0];
            const metaDiaria = parseInt(colaborador.meta_diaria_individual, 10) || 350;

            const opsRes = await pool.query(`
                SELECT op.id AS op_id, op.produto_id, p.nome AS produto_nome, 
                       op.quantidade_planejada, op.status,
                       TO_CHAR(op.data_programada, 'YYYY-MM-DD') AS data_programada,
                       COALESCE(op.categoria_producao, p.categoria_producao, p.categoria, 'Geral') AS categoria_producao,
                       COALESCE(op.tipo_op, 'MONTAGEM') AS tipo_op,
                       op.pedido_id, COALESCE(op.agrupada, FALSE) AS agrupada,
                       TO_CHAR(ped.data_entrega, 'YYYY-MM-DD') AS data_entrega,
                       cli.razao_social AS cliente_nome,
                       COALESCE((
                           SELECT json_agg(
                               json_build_object(
                                   'id', opo.id,
                                   'pedido_id', opo.pedido_id,
                                   'cliente_id', opo.cliente_id,
                                   'razao_social', c_orig.razao_social,
                                   'quantidade', opo.quantidade,
                                   'data_entrega', TO_CHAR(COALESCE(opo.data_entrega, p_orig.data_entrega), 'YYYY-MM-DD')
                               ) ORDER BY opo.id ASC
                           )
                           FROM ordem_producao_origem opo
                           LEFT JOIN cliente c_orig ON c_orig.id = opo.cliente_id
                           LEFT JOIN pedido p_orig ON p_orig.id = opo.pedido_id
                           WHERE opo.ordem_producao_id = op.id
                       ), '[]'::json) AS origens
                FROM ordem_producao op
                JOIN produto p ON p.id = op.produto_id
                LEFT JOIN pedido ped ON ped.id = op.pedido_id
                LEFT JOIN cliente cli ON cli.id = ped.cliente_id
                WHERE op.colaborador_id = $1
                  AND op.data_programada >= $2 AND op.data_programada <= $3
                  AND op.status IN ('FILA', 'PRODUZINDO', 'CONCLUIDA')
                  AND COALESCE(op.tipo_op, 'MONTAGEM') = 'MONTAGEM'
                ORDER BY op.data_programada ASC, op.id ASC
            `, [colaborador_id, data_inicio, data_fim]);

            const opsDetalhadas = await montarDetalhesOpsFicha(pool, opsRes.rows);

            const diasNomes = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
            const baseDate = parseDataLocal(data_inicio);
            const dias = [];
            let totalUnidadesSemana = 0;

            for (let i = 0; i < 5; i++) {
                const dObj = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + i);
                const dStr = formatarDataLocal(dObj);
                const opsDoDia = opsDetalhadas.filter(o => o.data_programada === dStr);
                const totalDia = opsDoDia.reduce((acc, o) => acc + (parseInt(o.quantidade_total, 10) || 0), 0);
                totalUnidadesSemana += totalDia;

                dias.push({
                    data: dStr,
                    dia_nome: diasNomes[dObj.getDay()],
                    meta_diaria_individual: metaDiaria,
                    total_unidades: totalDia,
                    ops: opsDoDia
                });
            }

            res.json({
                colaborador: {
                    id: colaborador.id,
                    nome: colaborador.nome,
                    meta_diaria_individual: metaDiaria,
                    eh_novato: colaborador.eh_novato
                },
                data_inicio,
                data_fim,
                total_unidades_semana: totalUnidadesSemana,
                dias
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 8c. MAPA DE PREPARO DE MASSAS E RECHEIOS (COZINHA) — GET /api/planejamento/mapa-preparo
    obterMapaPreparo: async (req, res) => {
        try {
            let { data_inicio, data_fim, data, datas } = req.query;
            let datasFiltro = null;

            if (datas !== undefined) {
                datasFiltro = String(datas)
                    .split(',')
                    .map(s => s.trim())
                    .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));

                if (datasFiltro.length === 0) {
                    return res.json({
                        status: 'sucesso',
                        datas: [],
                        data_inicio: null,
                        data_fim: null,
                        total_ops_planejadas: 0,
                        preparos: [],
                        massas: [],
                        recheios: [],
                        recheios_molhos_d1: [],
                        massas_d0: [],
                        insumos_consolidados: []
                    });
                }
                const ordenadas = [...datasFiltro].sort();
                data_inicio = ordenadas[0];
                data_fim = ordenadas[ordenadas.length - 1];
            } else if (data && (!data_inicio || !data_fim)) {
                data_inicio = data;
                data_fim = data;
            } else if (!data_inicio || !data_fim) {
                const sem = calcularSemanaUtil();
                data_inicio = sem.data_inicio;
                data_fim = sem.data_fim;
            }

            const opsQuery = datasFiltro
                ? `SELECT op.id AS op_id, op.produto_id, p.nome AS produto_nome,
                          op.quantidade_planejada, op.status,
                          TO_CHAR(op.data_programada, 'YYYY-MM-DD') AS data_programada,
                          op.colaborador_id, c.nome AS colaborador_nome
                   FROM ordem_producao op
                   JOIN produto p ON p.id = op.produto_id
                   LEFT JOIN colaborador c ON c.id = op.colaborador_id
                   WHERE TO_CHAR(op.data_programada, 'YYYY-MM-DD') = ANY($1)
                     AND op.status IN ('FILA', 'PRODUZINDO')
                     AND op.colaborador_id IS NOT NULL
                     AND COALESCE(op.tipo_op, 'MONTAGEM') = 'MONTAGEM'
                   ORDER BY op.data_programada ASC, op.id ASC`
                : `SELECT op.id AS op_id, op.produto_id, p.nome AS produto_nome,
                          op.quantidade_planejada, op.status,
                          TO_CHAR(op.data_programada, 'YYYY-MM-DD') AS data_programada,
                          op.colaborador_id, c.nome AS colaborador_nome
                   FROM ordem_producao op
                   JOIN produto p ON p.id = op.produto_id
                   LEFT JOIN colaborador c ON c.id = op.colaborador_id
                   WHERE op.data_programada >= $1 AND op.data_programada <= $2
                     AND op.status IN ('FILA', 'PRODUZINDO')
                     AND op.colaborador_id IS NOT NULL
                     AND COALESCE(op.tipo_op, 'MONTAGEM') = 'MONTAGEM'
                   ORDER BY op.data_programada ASC, op.id ASC`;

            const opsRes = await pool.query(
                opsQuery,
                datasFiltro ? [datasFiltro] : [data_inicio, data_fim]
            );

            const preparosMap = {};

            async function acumularReceitaPreparo(receitaId, pesoNecessarioKg, vinculoOp) {
                if (!pesoNecessarioKg || pesoNecessarioKg <= 0) return;

                const recRes = await pool.query(
                    'SELECT id, nome, categoria, peso_total FROM receita WHERE id = $1',
                    [receitaId]
                );
                if (recRes.rows.length === 0) return;
                const rec = recRes.rows[0];

                if (!preparosMap[rec.id]) {
                    const isRecheioOuMolho = rec.categoria === 'Recheio' || rec.categoria === 'Molho';
                    preparosMap[rec.id] = {
                        receita_id: rec.id,
                        nome: rec.nome,
                        categoria: rec.categoria || 'Geral',
                        turno_sugerido: isRecheioOuMolho ? 'D-1 (Véspera)' : 'D+0 (Dia da Montagem)',
                        peso_total_kg: 0,
                        raw_peso_total: rec.peso_total,
                        produtos_vinculados: []
                    };
                }

                preparosMap[rec.id].peso_total_kg += pesoNecessarioKg;
                if (vinculoOp) {
                    preparosMap[rec.id].produtos_vinculados.push({
                        op_id: vinculoOp.op_id,
                        produto_nome: vinculoOp.produto_nome,
                        quantidade_unidades: vinculoOp.quantidade_planejada,
                        peso_kg: parseFloat(pesoNecessarioKg.toFixed(3)),
                        data_programada: vinculoOp.data_programada,
                        colaborador_nome: vinculoOp.colaborador_nome || null
                    });
                }

                // Verificar se esta receita possui sub-receitas em cascata
                const itemsRes = await pool.query(
                    'SELECT * FROM receita_item WHERE receita_id = $1 ORDER BY id ASC',
                    [rec.id]
                );
                const pesoBaseKg = obterPesoTotalReceitaKg(rec.peso_total, itemsRes.rows);
                const scale = pesoBaseKg > 0 ? (pesoNecessarioKg / pesoBaseKg) : 0;

                for (const item of itemsRes.rows) {
                    if (item.tipo_origem === 'receita') {
                        const subPesoKg = (parseFloat(item.quantidade_gramas || 0) / 1000.0) * scale;
                        await acumularReceitaPreparo(item.origem_id, subPesoKg, {
                            op_id: vinculoOp?.op_id || null,
                            produto_nome: `${vinculoOp?.produto_nome || 'Sub-preparo'} (via ${rec.nome})`,
                            quantidade_planejada: vinculoOp?.quantidade_planejada || 0,
                            data_programada: vinculoOp?.data_programada || data_inicio,
                            colaborador_nome: vinculoOp?.colaborador_nome || null
                        });
                    }
                }
            }

            for (const op of opsRes.rows) {
                const ftrRes = await pool.query(
                    `SELECT receita_id, quantidade_necessaria
                     FROM ficha_tecnica_receita
                     WHERE produto_id = $1`,
                    [op.produto_id]
                );
                for (const ftr of ftrRes.rows) {
                    const pesoKg = parseFloat(ftr.quantidade_necessaria || 0) * parseInt(op.quantidade_planejada, 10);
                    await acumularReceitaPreparo(ftr.receita_id, pesoKg, op);
                }
            }

            const preparos = [];
            const insumosConsolidadosMap = {};

            for (const recId of Object.keys(preparosMap)) {
                const prep = preparosMap[recId];
                const pesoTotalKg = parseFloat(prep.peso_total_kg.toFixed(3));
                const itemsRes = await pool.query(
                    `SELECT ri.*, i.unidade_medida
                     FROM receita_item ri
                     LEFT JOIN insumo i ON i.id = ri.origem_id AND ri.tipo_origem = 'materia'
                     WHERE ri.receita_id = $1
                     ORDER BY ri.nome ASC`,
                    [prep.receita_id]
                );
                const pesoBaseKg = obterPesoTotalReceitaKg(prep.raw_peso_total, itemsRes.rows);
                const scaleFactor = pesoBaseKg > 0 ? (pesoTotalKg / pesoBaseKg) : 0;

                const ingredientes = itemsRes.rows.map(ri => {
                    const qtdKg = (parseFloat(ri.quantidade_gramas || 0) / 1000.0) * scaleFactor;
                    const qtdGramas = qtdKg * 1000.0;
                    if (ri.tipo_origem === 'materia') {
                        if (!insumosConsolidadosMap[ri.origem_id]) {
                            insumosConsolidadosMap[ri.origem_id] = {
                                insumo_id: ri.origem_id,
                                nome: ri.nome,
                                peso_total_kg: 0
                            };
                        }
                        insumosConsolidadosMap[ri.origem_id].peso_total_kg += qtdKg;
                    }
                    return {
                        origem_id: ri.origem_id,
                        tipo_origem: ri.tipo_origem,
                        nome: ri.nome,
                        qtd_kg: parseFloat(qtdKg.toFixed(3)),
                        qtd_gramas: Math.round(qtdGramas),
                        exibicao: qtdKg >= 1 ? `${qtdKg.toFixed(3)} kg` : `${Math.round(qtdGramas)} g`,
                        unidade: 'kg'
                    };
                });

                preparos.push({
                    receita_id: prep.receita_id,
                    nome: prep.nome,
                    categoria: prep.categoria,
                    turno_sugerido: prep.turno_sugerido,
                    peso_total_kg: pesoTotalKg,
                    instrucao_batelada: gerarInstrucaoBatelada(pesoTotalKg, 10),
                    ingredientes,
                    produtos_vinculados: prep.produtos_vinculados
                });
            }

            preparos.sort((a, b) => a.turno_sugerido.localeCompare(b.turno_sugerido) || a.nome.localeCompare(b.nome));

            const massas = preparos.filter(p => (p.categoria || '').toLowerCase().includes('massa'));
            const recheios = preparos.filter(p => !(p.categoria || '').toLowerCase().includes('massa'));
            const recheios_molhos_d1 = preparos.filter(p => p.turno_sugerido.startsWith('D-1'));
            const massas_d0 = preparos.filter(p => p.turno_sugerido.startsWith('D+0'));
            const insumos_consolidados = Object.values(insumosConsolidadosMap)
                .map(ins => ({
                    ...ins,
                    peso_total_kg: parseFloat(ins.peso_total_kg.toFixed(3)),
                    exibicao: ins.peso_total_kg >= 1
                        ? `${ins.peso_total_kg.toFixed(3)} kg`
                        : `${Math.round(ins.peso_total_kg * 1000)} g`
                }))
                .sort((a, b) => a.nome.localeCompare(b.nome));

            res.json({
                status: 'sucesso',
                datas: datasFiltro,
                data_inicio,
                data_fim,
                total_ops_planejadas: opsRes.rows.length,
                preparos,
                massas,
                recheios,
                recheios_molhos_d1,
                massas_d0,
                insumos_consolidados
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 8d. FICHAS CONSOLIDADAS POR COLABORADOR (1 OU TODOS) — GET /api/planejamento/fichas-colaboradores
    obterFichasColaboradores: async (req, res) => {
        try {
            let { data_inicio, data_fim, datas, colaborador_id, incluir_sem_ops } = req.query;
            let datasLista = null;

            if (datas !== undefined) {
                datasLista = Array.from(new Set(
                    String(datas)
                        .split(',')
                        .map(s => s.trim())
                        .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s))
                )).sort();

                if (datasLista.length === 0) {
                    return res.json({
                        status: 'sucesso',
                        data_inicio: null,
                        data_fim: null,
                        datas: [],
                        fichas: []
                    });
                }
                data_inicio = datasLista[0];
                data_fim = datasLista[datasLista.length - 1];
            } else {
                if (!data_inicio || !data_fim) {
                    const sem = calcularSemanaUtil();
                    data_inicio = sem.data_inicio;
                    data_fim = sem.data_fim;
                }
                datasLista = [];
                const ini = parseDataLocal(data_inicio);
                const fim = parseDataLocal(data_fim);
                for (let dt = new Date(ini.getFullYear(), ini.getMonth(), ini.getDate()); dt <= fim; dt.setDate(dt.getDate() + 1)) {
                    datasLista.push(formatarDataLocal(dt));
                }
            }

            const isTodos = !colaborador_id || String(colaborador_id).trim().toUpperCase() === 'TODOS';
            let colabsQuery = `
                SELECT id, nome, COALESCE(meta_diaria_individual, meta_diaria, 350) AS meta_diaria_individual
                FROM colaborador
                WHERE (status = 'Ativo' OR status IS NULL) AND COALESCE(ativo, TRUE) = TRUE
            `;
            const colabParams = [];
            if (!isTodos) {
                const colabIdNum = parseInt(colaborador_id, 10);
                if (isNaN(colabIdNum) || colabIdNum <= 0) {
                    return res.status(400).json({ status: 'erro', erro: 'colaborador_id inválido.' });
                }
                colabsQuery += ' AND id = $1';
                colabParams.push(colabIdNum);
            }
            colabsQuery += ' ORDER BY nome ASC';

            const colabsRes = await pool.query(colabsQuery, colabParams);
            if (!isTodos && colabsRes.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado.' });
            }

            const opsRes = await pool.query(`
                SELECT op.colaborador_id,
                       TO_CHAR(op.data_programada, 'YYYY-MM-DD') AS data_programada,
                       op.produto_id,
                       p.nome AS produto_nome,
                       SUM(op.quantidade_planejada)::int AS quantidade_total
                FROM ordem_producao op
                JOIN produto p ON p.id = op.produto_id
                WHERE TO_CHAR(op.data_programada, 'YYYY-MM-DD') = ANY($1)
                  AND op.status IN ('FILA', 'PRODUZINDO')
                  AND op.colaborador_id IS NOT NULL
                  AND COALESCE(op.tipo_op, 'MONTAGEM') = 'MONTAGEM'
                GROUP BY op.colaborador_id, TO_CHAR(op.data_programada, 'YYYY-MM-DD'), op.produto_id, p.nome
                ORDER BY op.colaborador_id ASC, data_programada ASC, p.nome ASC
            `, [datasLista]);

            const diasNomes = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
            const fichas = [];

            for (const colab of colabsRes.rows) {
                const meta = parseInt(colab.meta_diaria_individual, 10) || 350;
                let totalPeriodo = 0;
                const dias = datasLista.map(dStr => {
                    const dObj = parseDataLocal(dStr);
                    const itens = opsRes.rows
                        .filter(r => Number(r.colaborador_id) === Number(colab.id) && r.data_programada === dStr)
                        .map(r => ({
                            produto_id: r.produto_id,
                            produto_nome: r.produto_nome,
                            quantidade_total: parseInt(r.quantidade_total, 10) || 0
                        }));
                    const totalDia = itens.reduce((acc, it) => acc + it.quantidade_total, 0);
                    totalPeriodo += totalDia;
                    return {
                        data: dStr,
                        dia_nome: diasNomes[dObj.getDay()],
                        meta_diaria_individual: meta,
                        total_unidades: totalDia,
                        itens
                    };
                });

                const mostrarVazio = !isTodos || String(incluir_sem_ops) === 'true';
                if (totalPeriodo > 0 || mostrarVazio) {
                    fichas.push({
                        colaborador: {
                            id: colab.id,
                            nome: colab.nome,
                            meta_diaria_individual: meta
                        },
                        total_unidades: totalPeriodo,
                        dias
                    });
                }
            }

            res.json({
                status: 'sucesso',
                data_inicio,
                data_fim,
                datas: datasLista,
                fichas
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 9. AGENDAR OP (APENAS ATUALIZA DATA E COLABORADOR, SEM CRIAR SUB-OPS DE PREPARO)
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

            let aviso = null;
            let ultrapassaMeta = false;

            if (colaborador_id && data_programada) {
                const colabRes = await pool.query(
                    'SELECT nome, COALESCE(meta_diaria_individual, meta_diaria, 350) AS meta_diaria_individual FROM colaborador WHERE id = $1',
                    [colaborador_id]
                );
                if (colabRes.rows.length > 0) {
                    const meta = parseInt(colabRes.rows[0].meta_diaria_individual, 10) || 350;
                    const somaRes = await pool.query(
                        `SELECT COALESCE(SUM(quantidade_planejada), 0)::int AS total_dia
                         FROM ordem_producao
                         WHERE colaborador_id = $1 AND data_programada = $2
                           AND status != 'CONCLUIDA'
                           AND COALESCE(tipo_op, 'MONTAGEM') = 'MONTAGEM'`,
                        [colaborador_id, data_programada]
                    );
                    const totalDia = parseInt(somaRes.rows[0].total_dia || 0, 10);
                    if (totalDia > meta) {
                        ultrapassaMeta = true;
                        aviso = `⚠️ Capacidade diária de ${colabRes.rows[0].nome} ultrapassada: ${totalDia} / ${meta} un (+${totalDia - meta} un).`;
                    }
                }
            }

            res.json({
                status: 'sucesso',
                op: result.rows[0],
                ultrapassa_meta: ultrapassaMeta,
                aviso
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 9b. AGENDAR MÚLTIPLAS OPS EM LOTE — POST /api/planejamento/agendar-lote
    agendarLote: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { ops_ids, data_programada, colaborador_id } = req.body || {};

            if (!Array.isArray(ops_ids) || ops_ids.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Selecione pelo menos uma OP para atribuir.' });
            }

            const uniqueIds = Array.from(new Set(ops_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0)));
            if (uniqueIds.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'IDs de OP inválidos.' });
            }

            const colabIdNum = parseInt(colaborador_id, 10);
            if (!colabIdNum || isNaN(colabIdNum) || !data_programada) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Colaborador e data_programada são obrigatórios.' });
            }

            const colabRes = await client.query(
                'SELECT id, nome, COALESCE(meta_diaria_individual, meta_diaria, 350) AS meta_diaria_individual FROM colaborador WHERE id = $1 AND COALESCE(ativo, TRUE) = TRUE',
                [colabIdNum]
            );
            if (colabRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado ou inativo.' });
            }

            const opsCheck = await client.query(
                'SELECT id, status FROM ordem_producao WHERE id = ANY($1) FOR UPDATE',
                [uniqueIds]
            );
            if (opsCheck.rows.length !== uniqueIds.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Uma ou mais OPs selecionadas não foram encontradas.' });
            }
            const concluida = opsCheck.rows.find(o => o.status === 'CONCLUIDA');
            if (concluida) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: `OP #${concluida.id} já está concluída e não pode ser reprogramada.` });
            }

            const updatedRes = await client.query(
                `UPDATE ordem_producao
                 SET data_programada = $1, colaborador_id = $2
                 WHERE id = ANY($3)
                 RETURNING *`,
                [data_programada, colabIdNum, uniqueIds]
            );

            const meta = parseInt(colabRes.rows[0].meta_diaria_individual, 10) || 350;
            const somaRes = await client.query(
                `SELECT COALESCE(SUM(quantidade_planejada), 0)::int AS total_dia
                 FROM ordem_producao
                 WHERE colaborador_id = $1 AND data_programada = $2
                   AND status != 'CONCLUIDA'
                   AND COALESCE(tipo_op, 'MONTAGEM') = 'MONTAGEM'`,
                [colabIdNum, data_programada]
            );
            const totalDia = parseInt(somaRes.rows[0].total_dia || 0, 10);
            const ultrapassaMeta = totalDia > meta;
            const aviso = ultrapassaMeta
                ? `⚠️ Capacidade diária de ${colabRes.rows[0].nome} ultrapassada: ${totalDia} / ${meta} un (+${totalDia - meta} un).`
                : null;

            await client.query('COMMIT');

            res.json({
                status: 'sucesso',
                mensagem: `${updatedRes.rows.length} OP(s) atribuída(s) para ${colabRes.rows[0].nome}.`,
                ops: updatedRes.rows,
                total_dia: totalDia,
                meta_diaria_individual: meta,
                ultrapassa_meta: ultrapassaMeta,
                aviso
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    }
};

module.exports = planejamentoController;
