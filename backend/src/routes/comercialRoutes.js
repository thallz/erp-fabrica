const express = require('express');
const router = express.Router();
const comercialController = require('../controllers/comercialController');

// Clientes
router.post('/clientes', comercialController.criarCliente);
router.get('/clientes', comercialController.listarClientes);
router.put('/clientes/:id', comercialController.atualizarCliente);
router.delete('/clientes/:id', comercialController.excluirCliente);

// Pedidos de Venda
router.get('/pedidos', comercialController.listarPedidos);
router.get('/pedidos/:id', comercialController.obterPedido);
router.post('/pedidos', comercialController.lancarPedido);
router.put('/pedidos/:id', comercialController.atualizarPedido);

// Orçamentos Comerciais (Cotações B2B)
router.get('/orcamentos', comercialController.listarOrcamentos);
router.get('/orcamentos/:id', comercialController.obterOrcamento);
router.post('/orcamentos', comercialController.criarOrcamento);
router.post('/orcamentos/:id/aprovar', comercialController.aprovarOrcamento);
router.put('/orcamentos/:id/recusar', comercialController.recusarOrcamento);

module.exports = router;
