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
            res.json({ ...pedido.rows[0], itens: itens.rows });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3c. ATUALIZAR STATUS / ENTREGA DO PEDIDO
    atualizarPedido: async (req, res) => {
        try {
            const { id } = req.params;
            const { status, data_entrega } = req.body;
            const result = await pool.query(
                `UPDATE pedido
                 SET status = COALESCE($1, status),
                     data_entrega = COALESCE($2, data_entrega)
                 WHERE id = $3
                 RETURNING *`,
                [status || null, data_entrega || null, id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado' });
            }
            res.json(result.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 4. LANÇAR PEDIDO — baixa Câmara Fria + gera OP automática (transação única)
    lancarPedido: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { cliente_id, data_entrega, itens } = req.body;

            if (!itens || !itens.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Pedido sem itens.' });
            }

            let valorTotal = 0;
            const opsGeradas = [];
            const avisos = [];
            const baixasEstoque = [];

            for (const item of itens) {
                valorTotal += item.quantidade * item.preco_unitario;

                const prodResult = await client.query(
                    'SELECT id, nome, COALESCE(estoque_atual, 0) AS estoque_atual, categoria, categoria_producao FROM produto WHERE id = $1 FOR UPDATE',
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
                    estoque_atual: novoEstoque
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
                        op_id: opResult.rows[0].id,
                        produto_id: item.produto_id,
                        produto: produto.nome,
                        quantidade_planejada: quantidadeFaltante
                    });
                }
            }

            const statusPedido = opsGeradas.length > 0 ? 'PRODUZINDO' : 'CRIADO';

            const resultPedido = await client.query(
                'INSERT INTO pedido (cliente_id, data_entrega, valor_total, status) VALUES ($1, $2, $3, $4) RETURNING id',
                [cliente_id, data_entrega, valorTotal, statusPedido]
            );
            const pedidoId = resultPedido.rows[0].id;

            for (const item of itens) {
                await client.query(
                    'INSERT INTO item_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
                    [pedidoId, item.produto_id, item.quantidade, item.preco_unitario]
                );
            }

            await client.query('COMMIT');

            let mensagem = 'Pedido B2B lançado com sucesso!';
            if (opsGeradas.length) {
                mensagem += ` ${opsGeradas.length} OP(s) gerada(s) automaticamente na fila.`;
            }

            res.status(201).json({
                status: 'sucesso',
                pedido_id: pedidoId,
                mensagem,
                ops_geradas: opsGeradas,
                baixas_estoque: baixasEstoque,
                avisos
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    }
};

module.exports = comercialController;