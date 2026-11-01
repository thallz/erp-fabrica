const express = require('express');
const router = express.Router();
const estoqueController = require('../controllers/estoqueController');

// Entrada integrada de Compra / Nota Fiscal (Almoxarifado + Contas a Pagar)
router.post('/entrada-nf', estoqueController.registrarEntradaNF);

// Registrar movimentação (Entrada, Saída, Ajuste de Balanço, Perda/Descarte)
router.post('/movimentacoes', estoqueController.registrarMovimentacao);
router.post('/movimentar', estoqueController.registrarMovimentacao);

// Listar extrato / Kardex com filtros e paginação
router.get('/extrato', estoqueController.listarExtrato);

module.exports = router;
