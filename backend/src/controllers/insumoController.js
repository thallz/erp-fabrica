const pool = require('../config/db');

const insumoController = {
    // 1. Rota para CRIAR um novo insumo
    criar: async (req, res) => {
        try {
            const { nome, unidade_medida, custo_unitario, estoque_atual } = req.body;
            const novoInsumo = await pool.query(
                'INSERT INTO insumo (nome, unidade_medida, custo_unitario, estoque_atual) VALUES ($1, $2, $3, $4) RETURNING *',
                [nome, unidade_medida, custo_unitario, estoque_atual ?? 0]
            );
            res.status(201).json(novoInsumo.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2. Rota para LER (Listar) todos os insumos
    listar: async (req, res) => {
        try {
            const todosInsumos = await pool.query('SELECT * FROM insumo ORDER BY nome ASC');
            res.json(todosInsumos.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. Atualizar insumo existente
    atualizar: async (req, res) => {
        try {
            const { id } = req.params;
            const { nome, unidade_medida, custo_unitario, estoque_atual } = req.body;
            const result = await pool.query(
                'UPDATE insumo SET nome = $1, unidade_medida = $2, custo_unitario = $3, estoque_atual = $4 WHERE id = $5 RETURNING *',
                [nome, unidade_medida, custo_unitario, estoque_atual ?? 0, id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Insumo não encontrado' });
            }
            res.json(result.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 4. Excluir insumo
    excluir: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM insumo WHERE id = $1 RETURNING id', [id]);
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Insumo não encontrado' });
            }
            res.json({ status: 'sucesso', id: result.rows[0].id });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    }
};

module.exports = insumoController;