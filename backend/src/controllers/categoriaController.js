const pool = require('../config/db');

const categoriaController = {

  // GET /api/categorias?tipo=INSUMO
  listar: async (req, res) => {
    try {
      const { tipo } = req.query;
      const query = tipo
        ? 'SELECT * FROM categoria WHERE tipo = $1 ORDER BY nome ASC'
        : 'SELECT * FROM categoria ORDER BY tipo ASC, nome ASC';
      const result = await pool.query(query, tipo ? [tipo.toUpperCase()] : []);
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ erro: error.message });
    }
  },

  // POST /api/categorias  { nome, tipo }
  criar: async (req, res) => {
    try {
      const { nome, tipo } = req.body;
      if (!nome || !tipo) {
        return res.status(400).json({ erro: 'nome e tipo são obrigatórios' });
      }
      const result = await pool.query(
        'INSERT INTO categoria (nome, tipo) VALUES ($1, $2) RETURNING *',
        [nome.trim(), tipo.toUpperCase()]
      );
      res.status(201).json(result.rows[0]);
    } catch (error) {
      // Violação de UNIQUE
      if (error.code === '23505') {
        return res.status(409).json({ erro: `Categoria "${req.body.nome}" já existe para este tipo.` });
      }
      res.status(500).json({ erro: error.message });
    }
  },

  // DELETE /api/categorias/:id
  excluir: async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        'DELETE FROM categoria WHERE id = $1 RETURNING id',
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ erro: 'Categoria não encontrada' });
      }
      res.json({ status: 'sucesso', id: result.rows[0].id });
    } catch (error) {
      res.status(500).json({ erro: error.message });
    }
  }
};

module.exports = categoriaController;
