const pool = require('../config/db');

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

            // Insumos
            const insumosRes = await pool.query(`
                SELECT fti.insumo_id AS id, i.nome, i.unidade_medida, 
                       SUM(fti.quantidade * op.quantidade_planejada) AS demanda, 
                       COALESCE(i.estoque_atual, 0.0) AS estoque_atual
                FROM ordem_producao op
                JOIN ficha_tecnica_insumo fti ON fti.produto_id = op.produto_id
                JOIN insumo i ON i.id = fti.insumo_id
                WHERE op.data_programada >= $1 AND op.data_programada <= $2
                AND op.status != 'CONCLUIDA'
                GROUP BY fti.insumo_id, i.nome, i.unidade_medida, i.estoque_atual
                ORDER BY i.nome ASC
            `, [data_inicio, data_fim]);

            // Embalagens
            const embalagensRes = await pool.query(`
                SELECT fte.embalagem_id AS id, e.nome, 
                       SUM(fte.quantidade * op.quantidade_planejada) AS demanda, 
                       COALESCE(e.estoque_atual, 0) AS estoque_atual
                FROM ordem_producao op
                JOIN ficha_tecnica_embalagem fte ON fte.produto_id = op.produto_id
                JOIN embalagem e ON e.id = fte.embalagem_id
                WHERE op.data_programada >= $1 AND op.data_programada <= $2
                AND op.status != 'CONCLUIDA'
                GROUP BY fte.embalagem_id, e.nome, e.estoque_atual
                ORDER BY e.nome ASC
            `, [data_inicio, data_fim]);

            const itens = [];
            
            for (const r of insumosRes.rows) {
                const demanda = parseFloat(r.demanda);
                const estoque = parseFloat(r.estoque_atual);
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

            for (const r of embalagensRes.rows) {
                const demanda = parseInt(r.demanda, 10);
                const estoque = parseInt(r.estoque_atual, 10);
                const falta = Math.max(0, demanda - estoque);
                itens.push({
                    tipo: 'embalagem',
                    id: r.id,
                    nome: r.nome,
                    unidade: 'un',
                    demanda,
                    estoque_atual: estoque,
                    falta,
                    comprar_urgente: falta > 0
                });
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
                    INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, data_programada, categoria_producao)
                    VALUES ($1, $2, 'FILA', $3, $4) RETURNING *
                `, [produto_id, quantidade, data_programada, categoria]);

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

            if (!op_id || !quantidade_colaborador_1 || !colaborador_1_id || !data_1) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Campos obrigatórios ausentes.' });
            }

            // Buscar OP original
            const opRow = await client.query('SELECT * FROM ordem_producao WHERE id = $1', [op_id]);
            if (opRow.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'OP original não encontrada' });
            }
            const originalOp = opRow.rows[0];

            // Atualizar a OP original com a quantidade reduzida e alocar
            await client.query(
                `UPDATE ordem_producao 
                 SET quantidade_planejada = $1, colaborador_id = $2, data_programada = $3
                 WHERE id = $4`,
                [quantidade_colaborador_1, colaborador_1_id, data_1, op_id]
            );

            // Criar a nova OP com a quantidade restante
            let novaOp = null;
            if (quantidade_colaborador_2 > 0) {
                novaOp = await client.query(
                    `INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, colaborador_id, data_programada, categoria_producao)
                     VALUES ($1, $2, 'FILA', $3, $4, $5) RETURNING *`,
                    [
                        originalOp.produto_id, 
                        quantidade_colaborador_2, 
                        colaborador_2_id || null, 
                        data_2 || null, 
                        originalOp.categoria_producao
                    ]
                );
            }

            await client.query('COMMIT');
            res.json({
                status: 'sucesso',
                mensagem: 'OP dividida e alocada com sucesso.',
                op_original_atualizada_id: op_id,
                nova_op_criada: novaOp ? novaOp.rows[0] : null
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
