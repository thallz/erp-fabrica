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
router.delete('/op/:id', producaoController.excluirOP);
router.post('/intercorrencia', producaoController.registrarIntercorrencia);

module.exports = router;