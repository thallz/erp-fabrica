const express = require('express');
const router = express.Router();
const planejamentoController = require('../controllers/planejamentoController');

router.get('/sugestao-semanal', planejamentoController.gerarSugestaoSemanal);
router.post('/validar', planejamentoController.validarCapacidade);
router.get('/insumos-semana', planejamentoController.obterInsumosSemana);
router.post('/aplicar-sugestao', planejamentoController.aplicarSugestao);
router.post('/split-op', planejamentoController.splitOP);

module.exports = router;
