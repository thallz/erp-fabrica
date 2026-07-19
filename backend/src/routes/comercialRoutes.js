const express = require('express');
const router = express.Router();
const comercialController = require('../controllers/comercialController');

// Clientes
router.post('/clientes', comercialController.criarCliente);
router.get('/clientes', comercialController.listarClientes);
router.put('/clientes/:id', comercialController.atualizarCliente);
router.delete('/clientes/:id', comercialController.excluirCliente);

// Pedidos
router.get('/pedidos', comercialController.listarPedidos);
router.get('/pedidos/:id', comercialController.obterPedido);
router.post('/pedidos', comercialController.lancarPedido);
router.put('/pedidos/:id', comercialController.atualizarPedido);

module.exports = router;