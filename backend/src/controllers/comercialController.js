const pool = require('../config/db');

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

/**
 * Consolida eventuais itens repetidos do mesmo produto_id na mesma lista
 */
function consolidarItensPorProduto(itens) {
    const mapa = new Map();
    for (const raw of itens) {
        const prodId = parseInt(raw.produto_id, 10);
        const qtd = parseInt(raw.quantidade, 10);
        const preco = parseFloat(raw.preco_unitario);
        if (!prodId || isNaN(prodId) || isNaN(qtd) || qtd <= 0 || isNaN(preco) || preco < 0) {
            continue;
        }
        if (mapa.has(prodId)) {
            const existente = mapa.get(prodId);
            existente.quantidade += qtd;
            existente.preco_unitario = preco;
        } else {
            mapa.set(prodId, { produto_id: prodId, quantidade: qtd, preco_unitario: preco });
        }
    }
    return Array.from(mapa.values());
}

/**
 * Lógica transacional central de conversão/lançamento de Pedido de Venda:
 * 1) Baixa saldo disponível na Câmara Fria (produto.estoque_atual)
 * 2) Gera OPs de MONTAGEM (+ PREPARO em cascata) se faltar produto pronto
 * 3) Cria o registro em pedido + item_pedido
 * 4) Registra saídas de Câmara Fria no Kardex (movimentacao_estoque)
 * 5) Gera automaticamente o título em Contas a Receber (conta_receber)
 */
async function processarLancamentoPedidoTransacional(client, {
    cliente_id,
    data_entrega,
    itens,
    forma_pagamento = 'BOLETO',
    pagamento_tipo = 'A_PRAZO',
    data_vencimento = null,
    observacao_financeira = null
}) {
    const itensConsolidados = consolidarItensPorProduto(itens || []);
    if (!itensConsolidados.length) {
        throw new Error('Informe pelo menos um item válido no pedido.');
    }

    const cliRes = await client.query(
        'SELECT id, razao_social FROM cliente WHERE id = $1',
        [cliente_id]
    );
    if (cliRes.rows.length === 0) {
        throw new Error(`Cliente ID ${cliente_id} não encontrado.`);
    }
    const razaoSocial = cliRes.rows[0].razao_social || '';

    let valorTotal = 0;
    const opsGeradas = [];
    const avisos = [];
    const baixasEstoque = [];

    for (const item of itensConsolidados) {
        valorTotal += item.quantidade * item.preco_unitario;

        const prodResult = await client.query(
            `SELECT id, nome, COALESCE(estoque_atual, 0) AS estoque_atual,
                    COALESCE(cmv_estimado, 0) AS cmv_estimado, categoria, categoria_producao
             FROM produto WHERE id = $1 FOR UPDATE`,
            [item.produto_id]
        );
        if (prodResult.rows.length === 0) {
            throw new Error(`Produto ID ${item.produto_id} não encontrado.`);
        }

        const produto = prodResult.rows[0];
        const estoqueAnterior = parseInt(produto.estoque_atual, 10) || 0;
        const qtdVendida = parseInt(item.quantidade, 10);

        let novoEstoque = 0;
        let quantidadeFaltante = 0;

        if (qtdVendida <= estoqueAnterior) {
            novoEstoque = estoqueAnterior - qtdVendida;
        } else {
            quantidadeFaltante = qtdVendida - estoqueAnterior;
            novoEstoque = 0;
        }

        if (novoEstoque < 0) novoEstoque = 0;

        await client.query(
            'UPDATE produto SET estoque_atual = $1 WHERE id = $2',
            [novoEstoque, item.produto_id]
        );

        baixasEstoque.push({
            produto_id: item.produto_id,
            produto: produto.nome,
            vendido: qtdVendida,
            estoque_anterior: estoqueAnterior,
            estoque_atual: novoEstoque,
            custo_momento: parseFloat(produto.cmv_estimado || 0)
        });

        if (quantidadeFaltante > 0) {
            const ficha = await client.query(
                `SELECT 
                    (SELECT COUNT(*)::int FROM ficha_tecnica_insumo WHERE produto_id = $1) +
                    (SELECT COUNT(*)::int FROM ficha_tecnica_embalagem WHERE produto_id = $1) +
                    (SELECT COUNT(*)::int FROM ficha_tecnica_receita WHERE produto_id = $1) AS total`,
                [item.produto_id]
            );
            if (ficha.rows[0].total === 0) {
                avisos.push(
                    `"${produto.nome}": faltam ${quantidadeFaltante} un, mas não há ficha técnica cadastrada.`
                );
            }

            const opResult = await client.query(
                `INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, categoria_producao, tipo_op)
                 VALUES ($1, $2, 'FILA', $3, 'MONTAGEM') RETURNING id`,
                [item.produto_id, quantidadeFaltante, produto.categoria_producao || produto.categoria || 'Geral']
            );
            const montagemOpId = opResult.rows[0].id;
            await explodirEPrefabricarOPs(client, montagemOpId, item.produto_id, quantidadeFaltante);

            opsGeradas.push({
                op_id: montagemOpId,
                produto_id: item.produto_id,
                produto: produto.nome,
                quantidade_planejada: quantidadeFaltante
            });
        }
    }

    const statusPedido = opsGeradas.length > 0 ? 'PRODUZINDO' : 'CRIADO';

    const resultPedido = await client.query(
        'INSERT INTO pedido (cliente_id, data_entrega, valor_total, status) VALUES ($1, $2, $3, $4) RETURNING id',
        [cliente_id, data_entrega || null, valorTotal, statusPedido]
    );
    const pedidoId = resultPedido.rows[0].id;

    // Registrar baixas da Câmara Fria no Kardex (movimentacao_estoque)
    for (const baixa of baixasEstoque) {
        const qtdBaixada = baixa.estoque_anterior - baixa.estoque_atual;
        if (qtdBaixada > 0) {
            await client.query(
                `INSERT INTO movimentacao_estoque (
                    tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                    quantidade, unidade_medida, custo_unitario_momento,
                    saldo_anterior, saldo_posterior, documento_ref, observacao
                ) VALUES ('PRODUTO_ACABADO', NULL, $1, 'SAIDA', 'VENDA_PEDIDO', $2, 'un', $3, $4, $5, $6, $7)`,
                [
                    baixa.produto_id,
                    qtdBaixada,
                    baixa.custo_momento || 0,
                    baixa.estoque_anterior,
                    baixa.estoque_atual,
                    `Pedido #${pedidoId}`,
                    `Baixa automática na Câmara Fria pelo Pedido #${pedidoId}`
                ]
            );
        }
    }

    for (const item of itensConsolidados) {
        await client.query(
            'INSERT INTO item_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
            [pedidoId, item.produto_id, item.quantidade, item.preco_unitario]
        );
    }

    // 5. Gerar automaticamente o título em Contas a Receber (conta_receber)
    const formasValidas = ['BOLETO', 'PIX', 'DINHEIRO', 'CARTAO'];
    const formaBruta = String(forma_pagamento || 'BOLETO').trim().toUpperCase();
    const formaPgto = formasValidas.includes(formaBruta) ? formaBruta : 'BOLETO';
    const pgtoTipo = String(pagamento_tipo || 'A_PRAZO').trim().toUpperCase() === 'A_VISTA' ? 'A_VISTA' : 'A_PRAZO';

    const vencInformado = data_vencimento && String(data_vencimento).trim() ? String(data_vencimento).trim() : null;
    const entregaInformada = data_entrega && String(data_entrega).trim() ? String(data_entrega).trim() : null;

    const descricaoConta = (`Pedido #${pedidoId}${razaoSocial ? ' - ' + razaoSocial : ''}`).slice(0, 200);
    const docRefConta = formaPgto === 'BOLETO' ? `Boleto Pedido #${pedidoId}` : `Pedido #${pedidoId}`;
    const isAVista = pgtoTipo === 'A_VISTA';

    const crRes = await client.query(
        `INSERT INTO conta_receber (
            cliente_id, pedido_id, descricao, valor,
            data_emissao, data_vencimento, data_recebimento,
            status, forma_pagamento, documento_ref, observacao
        ) VALUES (
            $1, $2, $3, $4,
            CURRENT_DATE,
            CASE
                WHEN $5 THEN COALESCE($6::date, CURRENT_DATE)
                ELSE COALESCE($6::date, $7::date, (CURRENT_DATE + INTERVAL '15 days')::date)
            END,
            CASE WHEN $5 THEN CURRENT_DATE ELSE NULL END,
            CASE WHEN $5 THEN 'RECEBIDO' ELSE 'PENDENTE' END,
            $8, $9, $10
        ) RETURNING *`,
        [
            cliente_id,
            pedidoId,
            descricaoConta,
            valorTotal,
            isAVista,
            vencInformado,
            entregaInformada,
            formaPgto,
            docRefConta,
            observacao_financeira ? String(observacao_financeira).trim() : null
        ]
    );

    return {
        pedidoId,
        valorTotal,
        statusPedido,
        opsGeradas,
        baixasEstoque,
        avisos,
        contaReceber: crRes.rows[0]
    };
}

const comercialController = {
    // 1. CRIAR CLIENTE B2B
    criarCliente: async (req, res) => {
        try {
            const { razao_social, cnpj, telefone, endereco, tipo } = req.body;
            const novoCliente = await pool.query(
                'INSERT INTO cliente (razao_social, cnpj, telefone, endereco, tipo) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [razao_social, cnpj || '', telefone || '', endereco || '', tipo || 'B2B']
            );
            res.status(201).json(novoCliente.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2. LISTAR CLIENTES
    listarClientes: async (req, res) => {
        try {
            const clientes = await pool.query('SELECT id, razao_social, cnpj, telefone, endereco, tipo, criado_em FROM cliente ORDER BY razao_social ASC');
            res.json(clientes.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2b. ATUALIZAR CLIENTE
    atualizarCliente: async (req, res) => {
        try {
            const { id } = req.params;
            const { razao_social, cnpj, telefone, endereco, tipo } = req.body;
            const result = await pool.query(
                'UPDATE cliente SET razao_social = $1, cnpj = $2, telefone = $3, endereco = $4, tipo = $5 WHERE id = $6 RETURNING *',
                [razao_social, cnpj || '', telefone || '', endereco || '', tipo || 'B2B', id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Cliente não encontrado' });
            }
            res.json(result.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2c. EXCLUIR CLIENTE
    excluirCliente: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM cliente WHERE id = $1 RETURNING id', [id]);
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Cliente não encontrado' });
            }
            res.json({ status: 'sucesso', id: result.rows[0].id });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. LISTAR PEDIDOS
    listarPedidos: async (req, res) => {
        try {
            const pedidos = await pool.query(`
                SELECT p.id, p.data_pedido, p.data_entrega, p.status, p.valor_total,
                       c.razao_social, c.cnpj,
                       (SELECT COUNT(*)::int FROM item_pedido ip WHERE ip.pedido_id = p.id) AS total_itens
                FROM pedido p
                JOIN cliente c ON c.id = p.cliente_id
                WHERE p.status <> 'ORCAMENTO'
                ORDER BY p.data_pedido DESC
            `);
            res.json(pedidos.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3b. DETALHE DO PEDIDO
    obterPedido: async (req, res) => {
        try {
            const { id } = req.params;
            const pedido = await pool.query(`
                SELECT p.*, c.razao_social, c.cnpj, c.telefone
                FROM pedido p
                JOIN cliente c ON c.id = p.cliente_id
                WHERE p.id = $1
            `, [id]);
            if (pedido.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado' });
            }
            const itens = await pool.query(`
                SELECT ip.quantidade, ip.preco_unitario, pr.nome AS produto_nome, pr.id AS produto_id
                FROM item_pedido ip
                JOIN produto pr ON pr.id = ip.produto_id
                WHERE ip.pedido_id = $1
            `, [id]);
            const cr = await pool.query(`
                SELECT id, valor, data_vencimento, data_recebimento, status, forma_pagamento, documento_ref
                FROM conta_receber
                WHERE pedido_id = $1
                ORDER BY id DESC
                LIMIT 1
            `, [id]);
            res.json({
                ...pedido.rows[0],
                itens: itens.rows,
                conta_receber: cr.rows[0] || null
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3c. ATUALIZAR STATUS / ENTREGA DO PEDIDO
    atualizarPedido: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const { status, data_entrega } = req.body;

            const pedAntRes = await client.query('SELECT * FROM pedido WHERE id = $1 FOR UPDATE', [id]);
            if (pedAntRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado' });
            }
            const statusAnterior = pedAntRes.rows[0].status;

            const result = await client.query(
                `UPDATE pedido
                 SET status = COALESCE($1, status),
                     data_entrega = COALESCE($2, data_entrega)
                 WHERE id = $3
                 RETURNING *`,
                [status || null, data_entrega || null, id]
            );

            if (status === 'CANCELADO') {
                await client.query(
                    `UPDATE conta_receber
                     SET status = 'CANCELADO'
                     WHERE pedido_id = $1 AND status = 'PENDENTE'`,
                    [id]
                );
            }

            if (status === 'ENTREGUE' && statusAnterior !== 'ENTREGUE' && statusAnterior !== 'ORCAMENTO') {
                const docRef = `Pedido #${id}`;
                const itensPed = await client.query(
                    'SELECT produto_id, quantidade FROM item_pedido WHERE pedido_id = $1',
                    [id]
                );

                for (const ip of itensPed.rows) {
                    const jaBaixadoRes = await client.query(
                        `SELECT COALESCE(SUM(quantidade), 0) AS total_baixado
                         FROM movimentacao_estoque
                         WHERE tipo_estoque = 'PRODUTO_ACABADO'
                           AND produto_id = $1
                           AND documento_ref = $2
                           AND tipo_movimento = 'SAIDA'`,
                        [ip.produto_id, docRef]
                    );
                    const jaBaixado = Math.round(parseFloat(jaBaixadoRes.rows[0]?.total_baixado || 0));
                    const faltaBaixar = Math.max(0, parseInt(ip.quantidade, 10) - jaBaixado);

                    if (faltaBaixar > 0) {
                        const prodRes = await client.query(
                            'SELECT COALESCE(estoque_atual, 0) AS estoque_atual, COALESCE(cmv_estimado, 0) AS cmv_estimado FROM produto WHERE id = $1 FOR UPDATE',
                            [ip.produto_id]
                        );
                        if (prodRes.rows.length > 0) {
                            const saldoAnt = parseInt(prodRes.rows[0].estoque_atual || 0, 10);
                            const qtdSaida = Math.min(saldoAnt, faltaBaixar);
                            if (qtdSaida > 0) {
                                const saldoPost = saldoAnt - qtdSaida;
                                await client.query('UPDATE produto SET estoque_atual = $1 WHERE id = $2', [saldoPost, ip.produto_id]);
                                await client.query(
                                    `INSERT INTO movimentacao_estoque (
                                        tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                                        quantidade, unidade_medida, custo_unitario_momento,
                                        saldo_anterior, saldo_posterior, documento_ref, observacao
                                    ) VALUES ('PRODUTO_ACABADO', NULL, $1, 'SAIDA', 'VENDA_PEDIDO', $2, 'un', $3, $4, $5, $6, $7)`,
                                    [
                                        ip.produto_id,
                                        qtdSaida,
                                        parseFloat(prodRes.rows[0].cmv_estimado || 0),
                                        saldoAnt,
                                        saldoPost,
                                        docRef,
                                        `Saída na entrega do ${docRef}`
                                    ]
                                );
                            }
                        }
                    }
                }
            }

            await client.query('COMMIT');
            res.json(result.rows[0]);
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 4. LANÇAR PEDIDO DIRETO — baixa Câmara Fria + gera OP automática + gera Contas a Receber
    lancarPedido: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const {
                cliente_id,
                data_entrega,
                itens,
                forma_pagamento = 'BOLETO',
                pagamento_tipo = 'A_PRAZO',
                data_vencimento = null,
                observacao = null
            } = req.body;

            if (!itens || !itens.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Pedido sem itens.' });
            }

            const resultado = await processarLancamentoPedidoTransacional(client, {
                cliente_id,
                data_entrega,
                itens,
                forma_pagamento,
                pagamento_tipo,
                data_vencimento,
                observacao_financeira: observacao
            });

            await client.query('COMMIT');

            let mensagem = 'Pedido B2B lançado com sucesso!';
            if (resultado.opsGeradas.length) {
                mensagem += ` ${resultado.opsGeradas.length} OP(s) gerada(s) automaticamente na fila.`;
            }

            res.status(201).json({
                status: 'sucesso',
                pedido_id: resultado.pedidoId,
                mensagem,
                conta_receber: resultado.contaReceber,
                ops_geradas: resultado.opsGeradas,
                baixas_estoque: resultado.baixasEstoque,
                avisos: resultado.avisos
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // =========================================================================
    // 5. MÓDULO DE ORÇAMENTOS COMERCIAIS (COTAÇÕES B2B)
    // =========================================================================

    // GET /api/comercial/orcamentos
    listarOrcamentos: async (req, res) => {
        try {
            const orcamentos = await pool.query(`
                SELECT
                    o.id,
                    o.cliente_id,
                    o.data_orcamento,
                    o.data_validade,
                    o.status,
                    o.valor_total,
                    o.observacao,
                    o.pedido_id,
                    o.criado_em,
                    c.razao_social,
                    c.cnpj,
                    c.telefone,
                    (o.status = 'PENDENTE' AND o.data_validade < CURRENT_DATE) AS vencido,
                    (SELECT COUNT(*)::int FROM item_orcamento io WHERE io.orcamento_id = o.id) AS total_itens,
                    (SELECT COALESCE(SUM(io.quantidade), 0)::int FROM item_orcamento io WHERE io.orcamento_id = o.id) AS total_unidades,
                    COALESCE((
                        SELECT json_agg(
                            json_build_object(
                                'produto_id', io.produto_id,
                                'produto_nome', pr.nome,
                                'quantidade', io.quantidade,
                                'preco_unitario', io.preco_unitario
                            ) ORDER BY pr.nome
                        )
                        FROM item_orcamento io
                        JOIN produto pr ON pr.id = io.produto_id
                        WHERE io.orcamento_id = o.id
                    ), '[]'::json) AS itens
                FROM orcamento o
                JOIN cliente c ON c.id = o.cliente_id
                ORDER BY o.id DESC
            `);
            res.json(orcamentos.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // GET /api/comercial/orcamentos/:id
    obterOrcamento: async (req, res) => {
        try {
            const { id } = req.params;
            const orcRes = await pool.query(
                `SELECT o.*, c.razao_social, c.cnpj, c.telefone, c.endereco
                 FROM orcamento o
                 JOIN cliente c ON c.id = o.cliente_id
                 WHERE o.id = $1`,
                [id]
            );
            if (orcRes.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Orçamento não encontrado.' });
            }

            const itensRes = await pool.query(
                `SELECT io.produto_id, pr.nome AS produto_nome, io.quantidade, io.preco_unitario
                 FROM item_orcamento io
                 JOIN produto pr ON pr.id = io.produto_id
                 WHERE io.orcamento_id = $1
                 ORDER BY pr.nome ASC`,
                [id]
            );

            res.json({
                ...orcRes.rows[0],
                itens: itensRes.rows
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // POST /api/comercial/orcamentos
    // REGRA VITAL: NÃO altera estoque_atual de produto e NÃO gera ordem_producao!
    criarOrcamento: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { cliente_id, data_validade, observacao, itens } = req.body;

            const clienteIdNum = parseInt(cliente_id, 10);
            if (!clienteIdNum || isNaN(clienteIdNum)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Selecione um cliente válido.' });
            }
            if (!data_validade) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Informe a data de validade da proposta.' });
            }

            const itensConsolidados = consolidarItensPorProduto(itens || []);
            if (!itensConsolidados.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Adicione pelo menos um item válido ao orçamento.' });
            }

            let valorTotal = 0;
            for (const item of itensConsolidados) {
                valorTotal += item.quantidade * item.preco_unitario;
            }

            const obsLimpa = observacao && String(observacao).trim() ? String(observacao).trim() : null;

            const orcInsert = await client.query(
                `INSERT INTO orcamento (cliente_id, data_validade, status, valor_total, observacao)
                 VALUES ($1, $2, 'PENDENTE', $3, $4)
                 RETURNING *`,
                [clienteIdNum, data_validade, valorTotal, obsLimpa]
            );
            const novoOrc = orcInsert.rows[0];

            for (const item of itensConsolidados) {
                await client.query(
                    `INSERT INTO item_orcamento (orcamento_id, produto_id, quantidade, preco_unitario)
                     VALUES ($1, $2, $3, $4)`,
                    [novoOrc.id, item.produto_id, item.quantidade, item.preco_unitario]
                );
            }

            await client.query('COMMIT');

            res.status(201).json({
                status: 'sucesso',
                mensagem: `Orçamento #ORC-${novoOrc.id} criado com sucesso (sem reserva de estoque ou geração de OP).`,
                orcamento_id: novoOrc.id,
                valor_total: parseFloat(novoOrc.valor_total),
                orcamento: novoOrc
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // POST /api/comercial/orcamentos/:id/aprovar
    // Converte o orçamento em Pedido de Venda real, baixa Câmara Fria, gera OPs e gera Contas a Receber
    aprovarOrcamento: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const {
                data_entrega,
                forma_pagamento = 'BOLETO',
                pagamento_tipo = 'A_PRAZO',
                data_vencimento = null
            } = req.body || {};

            if (!data_entrega) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Informe a data de entrega esperada para aprovar o orçamento.'
                });
            }

            const orcRes = await client.query(
                'SELECT * FROM orcamento WHERE id = $1 FOR UPDATE',
                [id]
            );
            if (orcRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Orçamento não encontrado.' });
            }

            const orcamento = orcRes.rows[0];
            if (orcamento.status !== 'PENDENTE') {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: `Este orçamento já está com status "${orcamento.status}" e não pode ser aprovado novamente.`
                });
            }

            const itensOrcRes = await client.query(
                'SELECT produto_id, quantidade, preco_unitario FROM item_orcamento WHERE orcamento_id = $1',
                [id]
            );
            if (itensOrcRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Orçamento não possui itens para converter em pedido.' });
            }

            // Executar fluxo industrial completo do pedido (baixa Câmara Fria + OPs + Kardex + Pedido + Conta a Receber)
            const resultadoPedido = await processarLancamentoPedidoTransacional(client, {
                cliente_id: orcamento.cliente_id,
                data_entrega,
                itens: itensOrcRes.rows,
                forma_pagamento,
                pagamento_tipo,
                data_vencimento,
                observacao_financeira: orcamento.observacao || `Aprovado a partir do Orçamento #ORC-${id}`
            });

            const orcAtualizado = await client.query(
                `UPDATE orcamento
                 SET status = 'APROVADO',
                     pedido_id = $1
                 WHERE id = $2
                 RETURNING *`,
                [resultadoPedido.pedidoId, id]
            );

            await client.query('COMMIT');

            let mensagem = `Orçamento #ORC-${id} aprovado e convertido no Pedido #${resultadoPedido.pedidoId}!`;
            if (resultadoPedido.opsGeradas.length > 0) {
                mensagem += ` ${resultadoPedido.opsGeradas.length} OP(s) gerada(s) na fila de produção.`;
            }

            res.json({
                status: 'sucesso',
                mensagem,
                orcamento_id: parseInt(id, 10),
                pedido_id: resultadoPedido.pedidoId,
                orcamento: orcAtualizado.rows[0],
                conta_receber: resultadoPedido.contaReceber,
                ops_geradas: resultadoPedido.opsGeradas,
                baixas_estoque: resultadoPedido.baixasEstoque,
                avisos: resultadoPedido.avisos
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // PUT /api/comercial/orcamentos/:id/recusar
    recusarOrcamento: async (req, res) => {
        try {
            const { id } = req.params;
            const check = await pool.query('SELECT * FROM orcamento WHERE id = $1', [id]);
            if (check.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Orçamento não encontrado.' });
            }
            if (check.rows[0].status === 'APROVADO') {
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Não é possível recusar um orçamento já aprovado e convertido em pedido.'
                });
            }

            const updated = await pool.query(
                `UPDATE orcamento SET status = 'RECUSADO' WHERE id = $1 RETURNING *`,
                [id]
            );

            res.json({
                status: 'sucesso',
                mensagem: `Orçamento #ORC-${id} marcado como RECUSADO.`,
                orcamento: updated.rows[0]
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    }
};

module.exports = comercialController;
