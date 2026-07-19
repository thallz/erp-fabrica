const pool = require('../config/db');

const produtoController = {
    // 1. CRIAR PRODUTO + FICHA TÉCNICA
    criar: async (req, res) => {
        // Inicia uma conexão exclusiva para a Transação
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN'); // Trava o banco: "Comece a gravar, mas só salve se eu mandar"
            
            const { nome, preco_venda, cmv_estimado, margem_contribuicao, categoria, peso_produtividade, ficha_tecnica } = req.body;
            
            // Passo A: Gravar o Produto Final
            const resultProd = await client.query(
                'INSERT INTO produto (nome, preco_venda, cmv_estimado, margem_contribuicao, categoria, peso_produtividade) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                [nome, preco_venda, cmv_estimado, margem_contribuicao, categoria || 'Geral', parseFloat(peso_produtividade) || 1.0]
            );
            const produtoId = resultProd.rows[0].id;

            // Passo B: Gravar a Ficha Técnica (Explosão da Receita)
            // O frontend vai nos mandar um array (lista) de insumos usados neste produto
            if (ficha_tecnica && ficha_tecnica.length > 0) {
                for (const item of ficha_tecnica) {
                    await client.query(
                        'INSERT INTO ficha_tecnica_insumo (produto_id, insumo_id, quantidade) VALUES ($1, $2, $3)',
                        [produtoId, item.insumo_id, item.quantidade]
                    );
                }
            }

            await client.query('COMMIT'); // Tudo certo! Salva definitivamente.
            res.status(201).json({ 
                status: 'sucesso', 
                produto_id: produtoId, 
                mensagem: 'Produto e Ficha Técnica criados com sucesso!' 
            });

        } catch (error) {
            await client.query('ROLLBACK'); // Deu erro? Cancela tudo para não sujar o banco.
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release(); // Libera a conexão
        }
    },

    // 2. LISTAR PRODUTOS
    listar: async (req, res) => {
        try {
            const todosProdutos = await pool.query('SELECT * FROM produto ORDER BY nome ASC');
            res.json(todosProdutos.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. ATUALIZAR PRODUTO + FICHA TÉCNICA
    atualizar: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const { nome, preco_venda, cmv_estimado, margem_contribuicao, categoria, peso_produtividade, ficha_tecnica } = req.body;

            const result = await client.query(
                `UPDATE produto
                 SET nome = $1, preco_venda = $2, cmv_estimado = $3, margem_contribuicao = $4, categoria = $5, peso_produtividade = $6
                 WHERE id = $7 RETURNING id`,
                [nome, preco_venda, cmv_estimado, margem_contribuicao, categoria || 'Geral', parseFloat(peso_produtividade) || 1.0, id]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Produto não encontrado' });
            }

            await client.query('DELETE FROM ficha_tecnica_insumo WHERE produto_id = $1', [id]);
            if (ficha_tecnica && ficha_tecnica.length > 0) {
                for (const item of ficha_tecnica) {
                    await client.query(
                        'INSERT INTO ficha_tecnica_insumo (produto_id, insumo_id, quantidade) VALUES ($1, $2, $3)',
                        [id, item.insumo_id, item.quantidade]
                    );
                }
            }

            await client.query('COMMIT');
            res.json({ status: 'sucesso', produto_id: Number(id), mensagem: 'Produto atualizado com sucesso!' });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 4. AJUSTAR ESTOQUE CÂMARA FRIA
    ajustarEstoque: async (req, res) => {
        try {
            const { id } = req.params;
            const { estoque_atual } = req.body;
            const valor = Math.max(0, parseInt(estoque_atual, 10) || 0);
            const result = await pool.query(
                'UPDATE produto SET estoque_atual = $1 WHERE id = $2 RETURNING id, nome, estoque_atual',
                [valor, id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Produto não encontrado' });
            }
            res.json(result.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 5. EXCLUIR PRODUTO
    excluir: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM produto WHERE id = $1 RETURNING id', [id]);
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Produto não encontrado' });
            }
            res.json({ status: 'sucesso', id: result.rows[0].id });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 6. OBTER POR ID COM FICHA TÉCNICA E DETALHES
    obterPorId: async (req, res) => {
        try {
            const { id } = req.params;
            const prod = await pool.query('SELECT * FROM produto WHERE id = $1', [id]);
            if (prod.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Produto não encontrado' });
            }
            
            const insumos = await pool.query(`
                SELECT fti.insumo_id, fti.quantidade, i.nome, i.unidade_medida, i.estoque_atual
                FROM ficha_tecnica_insumo fti
                JOIN insumo i ON i.id = fti.insumo_id
                WHERE fti.produto_id = $1
            `, [id]);
            
            const embalagens = await pool.query(`
                SELECT fte.embalagem_id, fte.quantidade, e.nome, e.estoque_atual
                FROM ficha_tecnica_embalagem fte
                JOIN embalagem e ON e.id = fte.embalagem_id
                WHERE fte.produto_id = $1
            `, [id]);

            res.json({
                ...prod.rows[0],
                ficha_tecnica_insumos: insumos.rows,
                ficha_tecnica_embalagens: embalagens.rows
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    }
};

module.exports = produtoController;