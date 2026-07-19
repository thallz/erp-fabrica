const express = require('express');
const router = express.Router();
const produtoController = require('../controllers/produtoController');

// Rotas da API para Produtos
router.post('/', produtoController.criar);
router.get('/', produtoController.listar);
router.get('/:id', produtoController.obterPorId);
router.put('/:id', produtoController.atualizar);
router.patch('/:id/estoque', produtoController.ajustarEstoque);
router.delete('/:id', produtoController.excluir);

module.exports = router;