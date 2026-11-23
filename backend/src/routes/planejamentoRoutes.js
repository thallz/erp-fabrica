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
router.post('/agendar-lote', planejamentoController.agendarLote);
router.put('/op/:id/agendar', planejamentoController.agendarOP);
router.post('/agrupar-ops', planejamentoController.agruparOPs);
router.get('/validar-estoque', planejamentoController.validarEstoqueSemana);
router.get('/mapa-preparo', planejamentoController.obterMapaPreparo);
router.get('/fichas-colaboradores', planejamentoController.obterFichasColaboradores);
router.get('/ficha/:colaborador_id/:data', planejamentoController.obterFichaTrabalho);
router.get('/ficha-semana/:colaborador_id', planejamentoController.obterFichaSemana);

module.exports = router;
