/**
 * TESTE AUTOMATIZADO DO MÓDULO COMERCIAL DE ORÇAMENTOS (COTAÇÕES B2B -> CONVERSÃO EM PEDIDO & OP)
 * Execução: node backend/test_orcamentos.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('./src/config/db');
const { runMigrations } = require('./src/config/migrate');

const insumoController = require('./src/controllers/insumoController');
const receitaController = require('./src/controllers/receitaController');
const produtoController = require('./src/controllers/produtoController');
const comercialController = require('./src/controllers/comercialController');
const comercialRoutes = require('./src/routes/comercialRoutes');

let totalChecks = 0;
let totalFalhas = 0;

function mockRes() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
}

function verificar(descricao, condicao, valorObtido, valorEsperado) {
    totalChecks++;
    if (condicao) {
        console.log(`   ✅ [PASS] ${descricao} -> Obtido: ${valorObtido} | Esperado: ${valorEsperado}`);
    } else {
        totalFalhas++;
        console.error(`   ❌ [FAIL] ${descricao} -> Obtido: ${valorObtido} | Esperado: ${valorEsperado}`);
    }
}

function aproxIgual(a, b, tol = 0.001) {
    return Math.abs(Number(a) - Number(b)) <= tol;
}

function rotaRegistrada(router, metodo, caminho) {
    return router.stack.some(
        (layer) =>
            layer.route &&
            layer.route.path === caminho &&
            Boolean(layer.route.methods[metodo.toLowerCase()])
    );
}

async function executarTesteOrcamentos() {
    console.log('\n================================================================================');
    console.log('📄 AUDITORIA AUTOMATIZADA — ORÇAMENTOS B2B & CONVERSÃO AUTOMÁTICA EM PEDIDO/OP');
    console.log('================================================================================\n');

    try {
        await runMigrations();

        // =========================================================================
        // 0. VERIFICAR ROTAS DE ORÇAMENTO REGISTRADAS NO EXPRESS
        // =========================================================================
        console.log('🔌 ETAPA 0: Verificando registro das rotas de Orçamentos em comercialRoutes...');
        const rGetLista   = rotaRegistrada(comercialRoutes, 'GET', '/orcamentos');
        const rGetDetalhe = rotaRegistrada(comercialRoutes, 'GET', '/orcamentos/:id');
        const rPostCriar  = rotaRegistrada(comercialRoutes, 'POST', '/orcamentos');
        const rPostAprov  = rotaRegistrada(comercialRoutes, 'POST', '/orcamentos/:id/aprovar');
        const rPutRecusar = rotaRegistrada(comercialRoutes, 'PUT', '/orcamentos/:id/recusar');

        verificar(
            'Todas as 5 rotas REST de Orçamentos registradas em /api/comercial/orcamentos',
            rGetLista && rGetDetalhe && rPostCriar && rPostAprov && rPutRecusar,
            `GET=${rGetLista}, GET/:id=${rGetDetalhe}, POST=${rPostCriar}, POST/aprovar=${rPostAprov}, PUT/recusar=${rPutRecusar}`,
            'GET=true, GET/:id=true, POST=true, POST/aprovar=true, PUT/recusar=true'
        );

        // =========================================================================
        // 1. RESET DO BANCO DE DADOS PARA ESTADO VIRGEM
        // =========================================================================
        console.log('\n🧹 ETAPA 1: Resetando banco de dados via reset_db.sql...');
        const sqlReset = fs.readFileSync(path.join(__dirname, 'reset_db.sql'), 'utf8');
        await pool.query(sqlReset);

        const virgem = (
            await pool.query(`
                SELECT
                    (SELECT COUNT(*)::int FROM cliente) AS clientes,
                    (SELECT COUNT(*)::int FROM produto) AS produtos,
                    (SELECT COUNT(*)::int FROM orcamento) AS orcamentos,
                    (SELECT COUNT(*)::int FROM pedido) AS pedidos,
                    (SELECT COUNT(*)::int FROM ordem_producao) AS ops
            `)
        ).rows[0];

        verificar(
            'Banco de dados limpo em estado virgem',
            virgem.clientes === 0 &&
                virgem.produtos === 0 &&
                virgem.orcamentos === 0 &&
                virgem.pedidos === 0 &&
                virgem.ops === 0,
            `clientes=${virgem.clientes}, produtos=${virgem.produtos}, orcamentos=${virgem.orcamentos}, pedidos=${virgem.pedidos}, ops=${virgem.ops}`,
            'clientes=0, produtos=0, orcamentos=0, pedidos=0, ops=0'
        );

        // =========================================================================
        // 2. CADASTRO DE CLIENTE B2B E PRODUTO (COXINHA COM ESTOQUE = 0)
        // =========================================================================
        console.log('\n🏢 ETAPA 2: Cadastrando Cliente B2B e Produto "Coxinha" (estoque inicial = 0 un)...');

        const resCliente = mockRes();
        await comercialController.criarCliente(
            {
                body: {
                    razao_social: 'Padaria & Café Estrela B2B Ltda',
                    cnpj: '12.345.678/0001-99',
                    telefone: '11997776655',
                    endereco: 'Av. Industrial, 500',
                    tipo: 'B2B'
                }
            },
            resCliente
        );
        const clienteId = resCliente.body.id;

        // Criar insumo base para ficha técnica limpa da Coxinha
        const resInsumo = mockRes();
        await insumoController.criar(
            {
                body: {
                    nome: 'Farinha de Trigo',
                    categoria: 'Farináceo',
                    tipo_medida: 'Peso',
                    unidade_medida: 'kg',
                    preco_pago: 4.50,
                    peso_embalagem: 1000,
                    estoque_atual: 50
                }
            },
            resInsumo
        );
        const farinhaId = resInsumo.body.id;

        const resProd = mockRes();
        await produtoController.criar(
            {
                body: {
                    nome: 'Coxinha de Frango Catupiry',
                    preco_venda: 8.00,
                    categoria: 'Frito',
                    categoria_producao: 'Frito',
                    ficha_tecnica_insumos: [{ insumo_id: farinhaId, quantidade: 0.12 }]
                }
            },
            resProd
        );
        const coxinhaId = resProd.body.produto_id;

        // Garantir explicitamente que o estoque da Coxinha na Câmara Fria é 0
        const estInicialProd = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0];
        verificar(
            'Produto "Coxinha" cadastrado com estoque inicial igual a 0 un',
            parseInt(estInicialProd.estoque_atual, 10) === 0,
            `${parseInt(estInicialProd.estoque_atual, 10)} un`,
            '0 un'
        );

        // =========================================================================
        // 3. CRIAÇÃO DE ORÇAMENTO DE 50 COXINHAS (R$ 400,00) — SEM PRODUÇÃO FANTASMA
        // =========================================================================
        const datasDb = (
            await pool.query(`
                SELECT
                    TO_CHAR(CURRENT_DATE + INTERVAL '7 days', 'YYYY-MM-DD') AS validade_7d,
                    TO_CHAR(CURRENT_DATE + INTERVAL '3 days', 'YYYY-MM-DD') AS entrega_3d
            `)
        ).rows[0];

        console.log(`\n📝 ETAPA 3: Criando Orçamento de 50 Coxinhas (R$ 400,00) — Validade: ${datasDb.validade_7d}...`);

        const resCriarOrc = mockRes();
        await comercialController.criarOrcamento(
            {
                body: {
                    cliente_id: clienteId,
                    data_validade: datasDb.validade_7d,
                    observacao: 'Proposta para coffee break corporativo',
                    itens: [
                        {
                            produto_id: coxinhaId,
                            quantidade: 50,
                            preco_unitario: 8.00
                        }
                    ]
                }
            },
            resCriarOrc
        );
        const orcamentoId = resCriarOrc.body.orcamento_id;

        const orcDb = (await pool.query('SELECT * FROM orcamento WHERE id = $1', [orcamentoId])).rows[0];
        verificar(
            'Orçamento criado com status PENDENTE e valor_total de R$ 400,00',
            Boolean(
                resCriarOrc.statusCode === 201 &&
                    orcDb &&
                    orcDb.status === 'PENDENTE' &&
                    aproxIgual(orcDb.valor_total, 400.00) &&
                    orcDb.pedido_id === null
            ),
            orcDb
                ? `id=#ORC-${orcDb.id}, status=${orcDb.status}, valor=R$ ${parseFloat(orcDb.valor_total).toFixed(2)}, pedido_id=${orcDb.pedido_id}`
                : 'Não encontrado',
            'id=#ORC-1, status=PENDENTE, valor=R$ 400.00, pedido_id=null'
        );

        // Validar que o estoque de Coxinhas CONTINUA 0 e o Kardex da Câmara Fria não sofreu movimentação
        const prodAposOrc = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0];
        const movsAposOrc = (
            await pool.query(
                "SELECT COUNT(*)::int AS total FROM movimentacao_estoque WHERE tipo_estoque = 'PRODUTO_ACABADO'"
            )
        ).rows[0].total;
        verificar(
            'Estoque de Coxinhas CONTINUA 0 un (Orçamento não alterou saldo nem Kardex da Câmara Fria)',
            parseInt(prodAposOrc.estoque_atual, 10) === 0 && movsAposOrc === 0,
            `estoque_coxinha=${parseInt(prodAposOrc.estoque_atual, 10)} un, kardex_camara_fria=${movsAposOrc}`,
            'estoque_coxinha=0 un, kardex_camara_fria=0'
        );

        // Validar que a fila de OPs CONTINUA VAZIA (nenhuma OP fantasma gerada)
        const opsAposOrc = (await pool.query('SELECT COUNT(*)::int AS total FROM ordem_producao')).rows[0].total;
        const pedidosAposOrc = (await pool.query('SELECT COUNT(*)::int AS total FROM pedido')).rows[0].total;
        verificar(
            'Fila de OPs continua VAZIA (0 OPs e 0 Pedidos enquanto orçamento está PENDENTE)',
            opsAposOrc === 0 && pedidosAposOrc === 0,
            `ops_na_fila=${opsAposOrc}, pedidos=${pedidosAposOrc}`,
            'ops_na_fila=0, pedidos=0'
        );

        // =========================================================================
        // 4. APROVAÇÃO DO ORÇAMENTO (ENTREGA EM +3 DIAS) -> CONVERSÃO EM PEDIDO + OP
        // =========================================================================
        console.log(`\n✅ ETAPA 4: Aprovando Orçamento #ORC-${orcamentoId} com entrega para 3 dias à frente (${datasDb.entrega_3d})...`);

        const resAprovar = mockRes();
        await comercialController.aprovarOrcamento(
            {
                params: { id: orcamentoId },
                body: { data_entrega: datasDb.entrega_3d }
            },
            resAprovar
        );

        const orcAprovadoDb = (await pool.query('SELECT * FROM orcamento WHERE id = $1', [orcamentoId])).rows[0];
        verificar(
            'Orçamento mudou para status APROVADO e recebeu vínculo pedido_id',
            Boolean(
                resAprovar.statusCode === 200 &&
                    orcAprovadoDb &&
                    orcAprovadoDb.status === 'APROVADO' &&
                    orcAprovadoDb.pedido_id !== null
            ),
            `status=${orcAprovadoDb?.status}, pedido_id=#${orcAprovadoDb?.pedido_id}`,
            'status=APROVADO, pedido_id=#1'
        );

        const pedidoGeradoDb = (
            await pool.query(
                `SELECT p.*, TO_CHAR(p.data_entrega, 'YYYY-MM-DD') AS data_entrega_iso,
                        (SELECT SUM(quantidade)::int FROM item_pedido WHERE pedido_id = p.id) AS qtd_total
                 FROM pedido p WHERE p.id = $1`,
                [orcAprovadoDb.pedido_id]
            )
        ).rows[0];

        verificar(
            'Pedido de venda oficial criado com 50 coxinhas, R$ 400,00 e entrega em +3 dias',
            Boolean(
                pedidoGeradoDb &&
                    pedidoGeradoDb.cliente_id === clienteId &&
                    aproxIgual(pedidoGeradoDb.valor_total, 400.00) &&
                    pedidoGeradoDb.qtd_total === 50 &&
                    pedidoGeradoDb.data_entrega_iso === datasDb.entrega_3d
            ),
            pedidoGeradoDb
                ? `pedido=#${pedidoGeradoDb.id}, valor=R$ ${parseFloat(pedidoGeradoDb.valor_total).toFixed(2)}, qtd=${pedidoGeradoDb.qtd_total} un, entrega=${pedidoGeradoDb.data_entrega_iso}, status=${pedidoGeradoDb.status}`
                : 'Pedido não encontrado',
            `pedido=#1, valor=R$ 400.00, qtd=50 un, entrega=${datasDb.entrega_3d}, status=PRODUZINDO`
        );

        const opsGeradasDb = (
            await pool.query(
                `SELECT * FROM ordem_producao WHERE produto_id = $1 AND tipo_op = 'MONTAGEM' ORDER BY id DESC`,
                [coxinhaId]
            )
        ).rows;
        const opCoxinha = opsGeradasDb[0];

        verificar(
            'OP de MONTAGEM de 50 coxinhas gerada automaticamente na fila (pois estoque era 0)',
            Boolean(
                opsGeradasDb.length === 1 &&
                    opCoxinha &&
                    opCoxinha.tipo_op === 'MONTAGEM' &&
                    parseInt(opCoxinha.quantidade_planejada, 10) === 50 &&
                    opCoxinha.status === 'FILA'
            ),
            opCoxinha
                ? `op_id=#${opCoxinha.id}, tipo=${opCoxinha.tipo_op}, qtd_planejada=${opCoxinha.quantidade_planejada} un, status=${opCoxinha.status}`
                : 'Nenhuma OP gerada',
            'op_id=#1, tipo=MONTAGEM, qtd_planejada=50 un, status=FILA'
        );

        // =========================================================================
        // 5. RELATÓRIO FINAL
        // =========================================================================
        console.log('\n================================================================================');
        console.log(`📊 RESUMO DE VERIFICAÇÕES: ${totalChecks - totalFalhas}/${totalChecks} aprovadas`);
        if (totalFalhas === 0) {
            console.log('🎉 MÓDULO DE ORÇAMENTOS B2B & CONVERSÃO EM PEDIDO: 100% APROVADO');
            console.log('================================================================================\n');
            process.exitCode = 0;
        } else {
            console.error(`🚨 TESTE REPROVADO COM ${totalFalhas} FALHA(S).`);
            console.log('================================================================================\n');
            process.exitCode = 1;
        }
    } catch (erroFatal) {
        console.error('\n❌ ERRO FATAL DURANTE O TESTE DE ORÇAMENTOS:', erroFatal.message);
        console.error(erroFatal);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

executarTesteOrcamentos();
