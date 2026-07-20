const pool = require('../config/db');

const produtoController = {
    // 1. CRIAR PRODUTO + FICHAS TÉCNICAS
    criar: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            const { 
                nome, 
                preco_venda, 
                cmv_estimado, 
                margem_contribuicao, 
                categoria,
                categoria_producao, 
                peso_produtividade, 
                embalagem_id,
                capacidade_embalagem,
                rateio_embalagem,
                ficha_tecnica_receitas, 
                ficha_tecnica_insumos, 
                ficha_tecnica_embalagens 
            } = req.body;
            
            const cat = categoria || categoria_producao || 'Geral';
            const precoVendaNum = parseFloat(preco_venda) || 0;
            const embalagemIdNum = embalagem_id ? parseInt(embalagem_id, 10) : null;
            const capEmbalagemNum = parseFloat(capacidade_embalagem || 1);
            const rateioEmbalagemNum = parseFloat(rateio_embalagem || 0);

            // Passo A: Gravar o Produto Final
            const resultProd = await client.query(
                `INSERT INTO produto (nome, preco_venda, cmv_estimado, margem_contribuicao, categoria, categoria_producao, peso_produtividade, embalagem_id, capacidade_embalagem, rateio_embalagem) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
                [
                    nome, 
                    precoVendaNum, 
                    cmv_estimado || 0, 
                    margem_contribuicao || 1, 
                    cat, 
                    cat, 
                    parseFloat(peso_produtividade) || 1.0,
                    embalagemIdNum,
                    capEmbalagemNum,
                    rateioEmbalagemNum
                ]
            );
            const produtoId = resultProd.rows[0].id;

            // Passo B: Gravar as Fichas Técnicas (Receitas / Componentes, Insumos, Embalagens)
            if (ficha_tecnica_receitas && ficha_tecnica_receitas.length > 0) {
                for (const item of ficha_tecnica_receitas) {
                    const recId = item.receita_id;
                    const g = parseFloat(item.quantidade_gramas || (item.quantidade_necessaria ? item.quantidade_necessaria * 1000 : 0));
                    const kg = g / 1000.0;

                    // Tabela ficha_tecnica_receita (usada em OP e planejamento em kg)
                    await client.query(
                        'INSERT INTO ficha_tecnica_receita (produto_id, receita_id, quantidade_necessaria) VALUES ($1, $2, $3)',
                        [produtoId, recId, kg]
                    );

                    // Tabela ficha_tecnica_produto (usada em gramas)
                    await client.query(
                        'INSERT INTO ficha_tecnica_produto (produto_id, receita_id, quantidade_gramas) VALUES ($1, $2, $3)',
                        [produtoId, recId, g]
                    );
                }
            }

            if (ficha_tecnica_insumos && ficha_tecnica_insumos.length > 0) {
                for (const item of ficha_tecnica_insumos) {
                    await client.query(
                        'INSERT INTO ficha_tecnica_insumo (produto_id, insumo_id, quantidade) VALUES ($1, $2, $3)',
                        [produtoId, item.insumo_id, item.quantidade]
                    );
                }
            }

            if (ficha_tecnica_embalagens && ficha_tecnica_embalagens.length > 0) {
                for (const item of ficha_tecnica_embalagens) {
                    await client.query(
                        'INSERT INTO ficha_tecnica_embalagem (produto_id, embalagem_id, quantidade) VALUES ($1, $2, $3)',
                        [produtoId, item.embalagem_id, item.quantidade]
                    );
                }
            }

            await client.query('COMMIT');
            res.status(201).json({ 
                status: 'sucesso', 
                produto_id: produtoId, 
                mensagem: 'Produto e Ficha Técnica criados com sucesso!' 
            });

        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 2. LISTAR PRODUTOS
    listar: async (req, res) => {
        try {
            const query = `
                SELECT 
                    p.*,
                    i.nome AS embalagem_nome,
                    i.custo_unitario AS embalagem_custo_unitario,
                    COALESCE((
                        SELECT SUM((ftr.quantidade_necessaria) * r.custo_por_kg)
                        FROM ficha_tecnica_receita ftr
                        JOIN receita r ON r.id = ftr.receita_id
                        WHERE ftr.produto_id = p.id
                    ), 0) AS custo_ingredientes
                FROM produto p
                LEFT JOIN insumo i ON i.id = p.embalagem_id
                ORDER BY p.nome ASC
            `;
            const result = await pool.query(query);
            const produtos = result.rows;

            for (let p of produtos) {
                const recipesRes = await pool.query(`
                    SELECT ftr.receita_id, 
                           (ftr.quantidade_necessaria * 1000) AS quantidade_gramas, 
                           r.nome, r.categoria, r.custo_por_kg,
                           ((ftr.quantidade_necessaria * 1000) / 1000.0 * r.custo_por_kg) AS custo_item
                    FROM ficha_tecnica_receita ftr
                    JOIN receita r ON r.id = ftr.receita_id
                    WHERE ftr.produto_id = $1
                `, [p.id]);
                p.ficha_tecnica_receitas = recipesRes.rows;

                const cIngredientes = parseFloat(p.custo_ingredientes || 0);
                const rateioEmb     = parseFloat(p.rateio_embalagem || 0);
                const custoTotal    = cIngredientes + rateioEmb;
                const preco         = parseFloat(p.preco_venda || 0);
                const margemBruta   = preco - custoTotal;
                const margemPct     = preco > 0 ? (margemBruta / preco) * 100 : 0;

                p.custo_ingredientes      = cIngredientes;
                p.rateio_embalagem        = rateioEmb;
                p.custo_producao          = custoTotal;
                p.margem_bruta            = margemBruta;
                p.margem_contribuicao_pct = margemPct;
            }

            res.json(produtos);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. ATUALIZAR PRODUTO + FICHAS TÉCNICAS
    atualizar: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const { 
                nome, 
                preco_venda, 
                cmv_estimado, 
                margem_contribuicao, 
                categoria,
                categoria_producao, 
                peso_produtividade, 
                embalagem_id,
                capacidade_embalagem,
                rateio_embalagem,
                ficha_tecnica_receitas, 
                ficha_tecnica_insumos, 
                ficha_tecnica_embalagens 
            } = req.body;

            const cat = categoria || categoria_producao || 'Geral';
            const precoVendaNum = parseFloat(preco_venda) || 0;
            const embalagemIdNum = embalagem_id ? parseInt(embalagem_id, 10) : null;
            const capEmbalagemNum = parseFloat(capacidade_embalagem || 1);
            const rateioEmbalagemNum = parseFloat(rateio_embalagem || 0);

            const result = await client.query(
                `UPDATE produto
                 SET nome = $1, preco_venda = $2, cmv_estimado = $3, margem_contribuicao = $4, categoria = $5, categoria_producao = $6, peso_produtividade = $7, embalagem_id = $8, capacidade_embalagem = $9, rateio_embalagem = $10
                 WHERE id = $11 RETURNING id`,
                [
                    nome, 
                    precoVendaNum, 
                    cmv_estimado || 0, 
                    margem_contribuicao || 1, 
                    cat, 
                    cat, 
                    parseFloat(peso_produtividade) || 1.0, 
                    embalagemIdNum,
                    capEmbalagemNum,
                    rateioEmbalagemNum,
                    id
                ]
            );

            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Produto não encontrado' });
            }

            // Excluir fichas antigas
            await client.query('DELETE FROM ficha_tecnica_receita WHERE produto_id = $1', [id]);
            await client.query('DELETE FROM ficha_tecnica_produto WHERE produto_id = $1', [id]);
            await client.query('DELETE FROM ficha_tecnica_insumo WHERE produto_id = $1', [id]);
            await client.query('DELETE FROM ficha_tecnica_embalagem WHERE produto_id = $1', [id]);

            // Gravar novas fichas
            if (ficha_tecnica_receitas && ficha_tecnica_receitas.length > 0) {
                for (const item of ficha_tecnica_receitas) {
                    const recId = item.receita_id;
                    const g = parseFloat(item.quantidade_gramas || (item.quantidade_necessaria ? item.quantidade_necessaria * 1000 : 0));
                    const kg = g / 1000.0;

                    await client.query(
                        'INSERT INTO ficha_tecnica_receita (produto_id, receita_id, quantidade_necessaria) VALUES ($1, $2, $3)',
                        [id, recId, kg]
                    );

                    await client.query(
                        'INSERT INTO ficha_tecnica_produto (produto_id, receita_id, quantidade_gramas) VALUES ($1, $2, $3)',
                        [id, recId, g]
                    );
                }
            }

            if (ficha_tecnica_insumos && ficha_tecnica_insumos.length > 0) {
                for (const item of ficha_tecnica_insumos) {
                    await client.query(
                        'INSERT INTO ficha_tecnica_insumo (produto_id, insumo_id, quantidade) VALUES ($1, $2, $3)',
                        [id, item.insumo_id, item.quantidade]
                    );
                }
            }

            if (ficha_tecnica_embalagens && ficha_tecnica_embalagens.length > 0) {
                for (const item of ficha_tecnica_embalagens) {
                    await client.query(
                        'INSERT INTO ficha_tecnica_embalagem (produto_id, embalagem_id, quantidade) VALUES ($1, $2, $3)',
                        [id, item.embalagem_id, item.quantidade]
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

    // 6. OBTER POR ID COM FICHAS TÉCNICAS E DETALHES
    obterPorId: async (req, res) => {
        try {
            const { id } = req.params;
            const prod = await pool.query(`
                SELECT p.*, i.nome AS embalagem_nome, i.custo_unitario AS embalagem_custo_unitario
                FROM produto p
                LEFT JOIN insumo i ON i.id = p.embalagem_id
                WHERE p.id = $1
            `, [id]);

            if (prod.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Produto não encontrado' });
            }
            
            const receitas = await pool.query(`
                SELECT ftr.receita_id, ftr.quantidade_necessaria, (ftr.quantidade_necessaria * 1000) AS quantidade_gramas, r.nome, r.categoria, r.custo_por_kg
                FROM ficha_tecnica_receita ftr
                JOIN receita r ON r.id = ftr.receita_id
                WHERE ftr.produto_id = $1
            `, [id]);

            const insumos = await pool.query(`
                SELECT fti.insumo_id, fti.quantidade, i.nome, i.unidade_medida, i.estoque_atual
                FROM ficha_tecnica_insumo fti
                JOIN insumo i ON i.id = fti.insumo_id
                WHERE fti.produto_id = $1
            `, [id]);

            const custoIngredientes = receitas.rows.reduce((acc, r) => {
                return acc + (parseFloat(r.quantidade_necessaria || 0) * parseFloat(r.custo_por_kg || 0));
            }, 0);

            const rateioEmb = parseFloat(prod.rows[0].rateio_embalagem || 0);
            const custoTotal = custoIngredientes + rateioEmb;
            const preco = parseFloat(prod.rows[0].preco_venda || 0);
            const margemBruta = preco - custoTotal;
            const margemPct = preco > 0 ? (margemBruta / preco) * 100 : 0;

            res.json({
                ...prod.rows[0],
                custo_ingredientes: custoIngredientes,
                rateio_embalagem: rateioEmb,
                custo_producao: custoTotal,
                margem_bruta: margemBruta,
                margem_contribuicao_pct: margemPct,
                ficha_tecnica_receitas: receitas.rows,
                ficha_tecnica_insumos: insumos.rows
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    }
};

module.exports = produtoController;