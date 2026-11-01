const express = require('express');
const router = express.Router();
const financeiroController = require('../controllers/financeiroController');

router.get('/resumo', financeiroController.resumo);

// Contas a Receber (Integração automática com Vendas/Pedidos B2B)
router.get('/contas-receber', financeiroController.listarContasReceber);
router.post('/contas-receber', financeiroController.criarContaReceber);
router.put('/contas-receber/:id/receber', financeiroController.receberConta);

// Contas a Pagar (Integração Compras/NF & Despesas Operacionais)
router.get('/contas-pagar', financeiroController.listarContasPagar);
router.post('/contas-pagar', financeiroController.criarContaPagar);
router.put('/contas-pagar/:id/pagar', financeiroController.pagarConta);

module.exports = router;
