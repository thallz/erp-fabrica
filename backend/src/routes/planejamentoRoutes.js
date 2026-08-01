const express = require('express');
const router = express.Router();
const planejamentoController = require('../controllers/planejamentoController');

router.get('/sugestao-semanal', planejamentoController.gerarSugestaoSemanal);
router.post('/validar', planejamentoController.validarCapacidade);
router.get('/insumos-semana', planejamentoController.obterInsumosSemana);
router.post('/aplicar-sugestao', planejamentoController.aplicarSugestao);
router.post('/split-op', planejamentoController.splitOP);
router.get('/semanal', planejamentoController.obterPlanejamentoSemanal);
router.post('/agendar', planejamentoController.agendarOP);
router.put('/op/:id/agendar', planejamentoController.agendarOP);
router.get('/validar-estoque', planejamentoController.validarEstoqueSemana);
router.get('/ficha/:colaborador_id/:data', planejamentoController.obterFichaTrabalho);

module.exports = router;
