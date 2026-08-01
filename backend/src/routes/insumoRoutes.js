const express = require('express');
const router = express.Router();
const insumoController = require('../controllers/insumoController');

// Quando houver um POST na rota, vá para a função 'criar'
router.post('/', insumoController.criar);
router.get('/', insumoController.listar);
router.put('/:id', insumoController.atualizar);
router.post('/:id/entrada', insumoController.darEntrada);
router.delete('/:id', insumoController.excluir);

module.exports = router;