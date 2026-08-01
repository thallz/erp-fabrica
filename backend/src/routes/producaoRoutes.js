const express = require('express');
const router = express.Router();
const producaoController = require('../controllers/producaoController');

router.post('/alocar', producaoController.alocar);
router.get('/fila', producaoController.listarFila);
router.get('/programadas-hoje', producaoController.listarProgramadasHoje);
router.get('/colaboradores', producaoController.listarColaboradores);
router.get('/op/:op_id/impedimentos', producaoController.verificarImpedimentosOP);
router.post('/planejar', producaoController.planejarProducao);
router.get('/necessidade-compras', producaoController.necessidadeCompras);
router.put('/op/:id/iniciar', producaoController.iniciarOP);
router.put('/op/:id/finalizar', producaoController.finalizarOP);
router.put('/op/:id/agendar', producaoController.agendarOP);
router.put('/op/:id/status', producaoController.atualizarStatusOP);
router.post('/intercorrencia', producaoController.registrarIntercorrencia);

module.exports = router;