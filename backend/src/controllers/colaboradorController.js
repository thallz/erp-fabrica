const pool = require('../config/db');

const colaboradorController = {
    // 1. LISTAR COLABORADORES
    listar: async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM colaborador ORDER BY id ASC');
            res.json(result.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2. CRIAR COLABORADOR
    criar: async (req, res) => {
        try {
            const { nome, meta_diaria, eh_novato, status } = req.body;
            const meta = parseInt(meta_diaria, 10) || 350;
            const result = await pool.query(
                `INSERT INTO colaborador (nome, meta_diaria, meta_diaria_individual, eh_novato, status)
                 VALUES ($1, $2, $2, $3, $4) RETURNING *`,
                [nome, meta, eh_novato || false, status || 'Ativo']
            );
            res.status(201).json(result.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. ATUALIZAR COLABORADOR
    atualizar: async (req, res) => {
        try {
            const { id } = req.params;
            const { nome, meta_diaria, eh_novato, status } = req.body;
            const meta = parseInt(meta_diaria, 10) || 350;
            const result = await pool.query(
                `UPDATE colaborador
                 SET nome = $1, meta_diaria = $2, meta_diaria_individual = $2, eh_novato = $3, status = $4
                 WHERE id = $5 RETURNING *`,
                [nome, meta, eh_novato || false, status || 'Ativo', id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado' });
            }
            res.json(result.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 4. EXCLUIR COLABORADOR
    excluir: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM colaborador WHERE id = $1 RETURNING id', [id]);
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Colaborador não encontrado' });
            }
            res.json({ status: 'sucesso', mensagem: 'Colaborador excluído com sucesso', id: result.rows[0].id });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    }
};

module.exports = colaboradorController;
