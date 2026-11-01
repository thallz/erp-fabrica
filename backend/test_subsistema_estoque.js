/**
 * AUDITORIA AUTOMATIZADA DO SUBSISTEMA DE ESTOQUE (KARDEX, ALMOXARIFADO E CÂMARA FRIA)
 * Execução: node backend/test_subsistema_estoque.js
 */
const fs = require('fs');
const path = require('path');
const pool = require('./src/config/db');
const { runMigrations } = require('./src/config/migrate');

const insumoController = require('./src/controllers/insumoController');
const receitaController = require('./src/controllers/receitaController');
const produtoController = require('./src/controllers/produtoController');
const estoqueController = require('./src/controllers/estoqueController');
const producaoController = require('./src/controllers/producaoController');
const comercialController = require('./src/controllers/comercialController');

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

async function executarAuditoriaEstoque() {
    console.log('\n================================================================================');
    console.log('🧪 INICIANDO AUDITORIA AUTOMATIZADA — SUBSISTEMA DE ESTOQUE & KARDEX');
    console.log('================================================================================\n');

    try {
        // Garantir estrutura e migrações atualizadas antes do reset
        await runMigrations();

        // =========================================================================
        // 1. RESET DO BANCO DE DADOS PARA ESTADO VIRGEM (reset_db.sql)
        // =========================================================================
        console.log('🧹 ETAPA 1: Resetando banco de dados via reset_db.sql...');
        const sqlResetPath = path.join(__dirname, 'reset_db.sql');
        const sqlReset = fs.readFileSync(sqlResetPath, 'utf8');
        await pool.query(sqlReset);

        const checkVirgem = await pool.query(`
            SELECT
                (SELECT COUNT(*)::int FROM insumo) AS insumos,
                (SELECT COUNT(*)::int FROM produto) AS produtos,
                (SELECT COUNT(*)::int FROM movimentacao_estoque) AS movs
        `);
        const contagens = checkVirgem.rows[0];
        verificar(
            'Banco de dados limpo em estado virgem (reset_db.sql)',
            contagens.insumos === 0 && contagens.produtos === 0 && contagens.movs === 0,
            `insumos=${contagens.insumos}, produtos=${contagens.produtos}, kardex=${contagens.movs}`,
            'insumos=0, produtos=0, kardex=0'
        );

        // =========================================================================
        // 2. CICLO DE MATÉRIA-PRIMA (ALMOXARIFADO)
        // =========================================================================
        console.log('\n📦 ETAPA 2: Simulando Ciclo de Matéria-Prima (Almoxarifado)...');

        // Cadastro preliminar da Farinha de Trigo com estoque 0 kg e preço antigo R$ 6,00/kg
        const resCriarFarinha = mockRes();
        await insumoController.criar(
            {
                body: {
                    nome: 'Farinha de Trigo',
                    categoria: 'Farináceo',
                    tipo_medida: 'Peso',
                    unidade_medida: 'kg',
                    preco_pago: 6.00,
                    peso_embalagem: 1000,
                    estoque_atual: 0
                }
            },
            resCriarFarinha
        );
        const farinhaId = resCriarFarinha.body.id;

        // Cadastro de Água (custo R$ 0,00/kg) + Receita de Massa Proporcional (600g Farinha + 400g Água = 1kg)
        const resCriarAgua = mockRes();
        await insumoController.criar(
            {
                body: {
                    nome: 'Água Filtrada',
                    categoria: 'Outros',
                    tipo_medida: 'Peso',
                    unidade_medida: 'kg',
                    preco_pago: 0,
                    peso_embalagem: 1000,
                    estoque_atual: 100
                }
            },
            resCriarAgua
        );
        const aguaId = resCriarAgua.body.id;

        // Receita 1: Massa Pura de Farinha (1000g Farinha -> 100% proporcional = R$ 6,00/kg inicialmente)
        const resRecPura = mockRes();
        await receitaController.criar(
            {
                body: {
                    nome: 'Empanamento Farinha Pura',
                    categoria: 'Massa',
                    itens: [
                        { tipoOrigem: 'materia', idOrigem: farinhaId, nome: 'Farinha de Trigo', g: 1000 }
                    ]
                }
            },
            resRecPura
        );
        const receitaPuraId = resRecPura.body.id;

        // Receita 2: Massa de Coxinha (600g Farinha + 400g Água = 1000g -> 60% de Farinha)
        const resRecMassa = mockRes();
        await receitaController.criar(
            {
                body: {
                    nome: 'Massa Tradicional de Coxinha',
                    categoria: 'Massa',
                    itens: [
                        { tipoOrigem: 'materia', idOrigem: farinhaId, nome: 'Farinha de Trigo', g: 600 },
                        { tipoOrigem: 'materia', idOrigem: aguaId, nome: 'Água Filtrada', g: 400 }
                    ]
                }
            },
            resRecMassa
        );
        const receitaMassaId = resRecMassa.body.id;

        // -------------------------------------------------------------------------
        // 2.a) Entrada por Compra: 50 kg de Farinha de Trigo a R$ 4,50/kg (NF-1020)
        // -------------------------------------------------------------------------
        console.log('\n   🔹 2.a) Entrada por Compra (50 kg de Farinha a R$ 4,50/kg — Doc: NF-1020)');
        const resEntradaCompra = mockRes();
        await estoqueController.registrarMovimentacao(
            {
                body: {
                    tipo_estoque: 'MATERIA_PRIMA',
                    insumo_id: farinhaId,
                    tipo_movimento: 'ENTRADA',
                    motivo: 'COMPRA_FORNECEDOR',
                    quantidade: 50,
                    novo_custo_unitario: 4.50,
                    preco_pago: 225.00,
                    modo_preco: 'TOTAL',
                    documento_ref: 'NF-1020',
                    observacao: 'Compra de fornecedor Moinho Sul'
                }
            },
            resEntradaCompra
        );

        const farinhaAposCompra = (await pool.query('SELECT estoque_atual, custo_unitario FROM insumo WHERE id = $1', [farinhaId])).rows[0];
        const estFarinhaCompra = parseFloat(farinhaAposCompra.estoque_atual);
        verificar(
            'Estoque atual da Farinha após compra',
            aproxIgual(estFarinhaCompra, 50),
            `${estFarinhaCompra.toFixed(2)} kg`,
            '50.00 kg'
        );

        const movCompraRes = await pool.query(
            `SELECT * FROM movimentacao_estoque
             WHERE insumo_id = $1 AND documento_ref = 'NF-1020'
             ORDER BY id DESC LIMIT 1`,
            [farinhaId]
        );
        const movCompra = movCompraRes.rows[0];
        verificar(
            'Kardex gravou ENTRADA (NF-1020) com saldo_anterior=0 e saldo_posterior=50',
            Boolean(
                movCompra &&
                movCompra.tipo_movimento === 'ENTRADA' &&
                aproxIgual(movCompra.saldo_anterior, 0) &&
                aproxIgual(movCompra.saldo_posterior, 50) &&
                movCompra.documento_ref === 'NF-1020'
            ),
            movCompra
                ? `tipo=${movCompra.tipo_movimento}, ant=${parseFloat(movCompra.saldo_anterior)}, post=${parseFloat(movCompra.saldo_posterior)}, doc=${movCompra.documento_ref}`
                : 'Registro não encontrado',
            'tipo=ENTRADA, ant=0, post=50, doc=NF-1020'
        );

        // -------------------------------------------------------------------------
        // 2.b) Recálculo em Cascata das Receitas (R$ 4,50/kg proporcional)
        // -------------------------------------------------------------------------
        console.log('\n   🔹 2.b) Recálculo em Cascata de Receitas (base R$ 4,50/kg)');
        const recPuraDb = (await pool.query('SELECT custo_por_kg FROM receita WHERE id = $1', [receitaPuraId])).rows[0];
        const recMassaDb = (await pool.query('SELECT custo_por_kg FROM receita WHERE id = $1', [receitaMassaId])).rows[0];
        const itemFarinhaNaMassa = (await pool.query(
            'SELECT custo_unitario, custo FROM receita_item WHERE receita_id = $1 AND origem_id = $2',
            [receitaMassaId, farinhaId]
        )).rows[0];

        const custoKgPura = parseFloat(recPuraDb.custo_por_kg);
        const custoKgMassa = parseFloat(recMassaDb.custo_por_kg); // 600g de R$ 4,50/kg em 1kg = R$ 2,70/kg
        const custoUnitItem = parseFloat(itemFarinhaNaMassa.custo_unitario);

        verificar(
            'Receita 100% Farinha assumiu custo exato de R$ 4,50/kg',
            aproxIgual(custoKgPura, 4.50),
            `R$ ${custoKgPura.toFixed(2)}/kg`,
            'R$ 4.50/kg'
        );
        verificar(
            'Receita proporcional (60% Farinha) recalculou para R$ 2,70/kg (base R$ 4,50/kg)',
            aproxIgual(custoKgMassa, 2.70) && aproxIgual(custoUnitItem, 4.50),
            `custo_receita=R$ ${custoKgMassa.toFixed(2)}/kg (insumo=R$ ${custoUnitItem.toFixed(2)}/kg)`,
            'custo_receita=R$ 2.70/kg (insumo=R$ 4.50/kg)'
        );

        // -------------------------------------------------------------------------
        // 2.c) Saída por Perda/Avaria: Descarte de 2 kg ('AVARIA_DESCARTE')
        // -------------------------------------------------------------------------
        console.log('\n   🔹 2.c) Saída por Perda/Avaria (2 kg — "Saco rasgado no transporte")');
        const resPerdaFarinha = mockRes();
        await estoqueController.registrarMovimentacao(
            {
                body: {
                    tipo_estoque: 'MATERIA_PRIMA',
                    insumo_id: farinhaId,
                    tipo_movimento: 'PERDA',
                    motivo: 'AVARIA_DESCARTE',
                    quantidade: 2,
                    observacao: 'Saco rasgado no transporte'
                }
            },
            resPerdaFarinha
        );

        const farinhaAposPerda = (await pool.query('SELECT estoque_atual FROM insumo WHERE id = $1', [farinhaId])).rows[0];
        const estFarinhaPerda = parseFloat(farinhaAposPerda.estoque_atual);
        verificar(
            'Estoque da Farinha caiu para 48 kg após perda de 2 kg',
            aproxIgual(estFarinhaPerda, 48),
            `${estFarinhaPerda.toFixed(2)} kg`,
            '48.00 kg'
        );

        const movPerdaFarinha = (await pool.query(
            `SELECT * FROM movimentacao_estoque
             WHERE insumo_id = $1 AND tipo_movimento = 'PERDA'
             ORDER BY id DESC LIMIT 1`,
            [farinhaId]
        )).rows[0];

        verificar(
            'Kardex registrou PERDA (AVARIA_DESCARTE) com saldo_anterior=50 e saldo_posterior=48',
            Boolean(
                movPerdaFarinha &&
                movPerdaFarinha.tipo_movimento === 'PERDA' &&
                movPerdaFarinha.motivo === 'AVARIA_DESCARTE' &&
                aproxIgual(movPerdaFarinha.saldo_anterior, 50) &&
                aproxIgual(movPerdaFarinha.saldo_posterior, 48) &&
                movPerdaFarinha.observacao === 'Saco rasgado no transporte'
            ),
            movPerdaFarinha
                ? `tipo=${movPerdaFarinha.tipo_movimento}, ant=${parseFloat(movPerdaFarinha.saldo_anterior)}, post=${parseFloat(movPerdaFarinha.saldo_posterior)}, obs="${movPerdaFarinha.observacao}"`
                : 'Registro não encontrado',
            'tipo=PERDA, ant=50, post=48, obs="Saco rasgado no transporte"'
        );

        // -------------------------------------------------------------------------
        // 2.d) Ajuste de Inventário (Balanço Físico): Contagem real = 45 kg
        // -------------------------------------------------------------------------
        console.log('\n   🔹 2.d) Ajuste de Inventário / Balanço Físico (Contagem real: 45 kg)');
        const resAjusteFarinha = mockRes();
        await estoqueController.registrarMovimentacao(
            {
                body: {
                    tipo_estoque: 'MATERIA_PRIMA',
                    insumo_id: farinhaId,
                    tipo_movimento: 'AJUSTE',
                    motivo: 'INVENTARIO_BALANCO',
                    quantidade: 45,
                    observacao: 'Diferença de 3 kg não explicada no balanço físico'
                }
            },
            resAjusteFarinha
        );

        const farinhaAposAjuste = (await pool.query('SELECT estoque_atual FROM insumo WHERE id = $1', [farinhaId])).rows[0];
        const estFarinhaAjuste = parseFloat(farinhaAposAjuste.estoque_atual);
        verificar(
            'Estoque da Farinha corrigido exatamente para 45 kg',
            aproxIgual(estFarinhaAjuste, 45),
            `${estFarinhaAjuste.toFixed(2)} kg`,
            '45.00 kg'
        );

        const movAjusteFarinha = (await pool.query(
            `SELECT * FROM movimentacao_estoque
             WHERE insumo_id = $1 AND tipo_movimento = 'AJUSTE'
             ORDER BY id DESC LIMIT 1`,
            [farinhaId]
        )).rows[0];

        verificar(
            'Kardex registrou AJUSTE com saldo_anterior=48 e saldo_posterior=45',
            Boolean(
                movAjusteFarinha &&
                movAjusteFarinha.tipo_movimento === 'AJUSTE' &&
                aproxIgual(movAjusteFarinha.saldo_anterior, 48) &&
                aproxIgual(movAjusteFarinha.saldo_posterior, 45)
            ),
            movAjusteFarinha
                ? `tipo=${movAjusteFarinha.tipo_movimento}, ant=${parseFloat(movAjusteFarinha.saldo_anterior)}, post=${parseFloat(movAjusteFarinha.saldo_posterior)}`
                : 'Registro não encontrado',
            'tipo=AJUSTE, ant=48, post=45'
        );

        // =========================================================================
        // 3. CICLO DE PRODUTO ACABADO (CÂMARA FRIA)
        // =========================================================================
        console.log('\n❄️ ETAPA 3: Simulando Ciclo de Produto Acabado (Câmara Fria)...');

        // Criar produto acabado Coxinha (estoque inicial = 0 un)
        const resCriarProd = mockRes();
        await produtoController.criar(
            {
                body: {
                    nome: 'Coxinha de Frango Tradicional',
                    preco_venda: 5.50,
                    categoria: 'Frito',
                    categoria_producao: 'Frito',
                    ficha_tecnica_receitas: [
                        { receita_id: receitaMassaId, quantidade_gramas: 100 }
                    ]
                }
            },
            resCriarProd
        );
        const coxinhaId = resCriarProd.body.produto_id;

        // -------------------------------------------------------------------------
        // 3.a) Entrada por Produção: Conclusão de OP de 100 unidades de Coxinha
        // -------------------------------------------------------------------------
        console.log('\n   🔹 3.a) Entrada por Produção (Conclusão de OP de 100 un de Coxinha)');
        const opInsert = await pool.query(
            `INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, tipo_op, categoria_producao)
             VALUES ($1, 100, 'PRODUZINDO', 'MONTAGEM', 'Frito') RETURNING id`,
            [coxinhaId]
        );
        const opId = opInsert.rows[0].id;

        const resFinalizarOP = mockRes();
        await producaoController.finalizarOP({ params: { id: opId } }, resFinalizarOP);

        const coxinhaAposOP = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0];
        const estCoxinhaOP = parseInt(coxinhaAposOP.estoque_atual, 10);
        verificar(
            'Estoque de Coxinhas na Câmara Fria subiu de 0 para 100 un',
            estCoxinhaOP === 100,
            `${estCoxinhaOP} un`,
            '100 un'
        );

        const movEntradaOP = (await pool.query(
            `SELECT * FROM movimentacao_estoque
             WHERE tipo_estoque = 'PRODUTO_ACABADO'
               AND produto_id = $1
               AND tipo_movimento = 'ENTRADA'
               AND motivo = 'PRODUCAO_CONCLUIDA'
             ORDER BY id DESC LIMIT 1`,
            [coxinhaId]
        )).rows[0];

        verificar(
            'Extrato gerou ENTRADA com motivo PRODUCAO_CONCLUIDA (0 -> 100 un)',
            Boolean(
                movEntradaOP &&
                movEntradaOP.tipo_movimento === 'ENTRADA' &&
                movEntradaOP.motivo === 'PRODUCAO_CONCLUIDA' &&
                aproxIgual(movEntradaOP.saldo_anterior, 0) &&
                aproxIgual(movEntradaOP.saldo_posterior, 100)
            ),
            movEntradaOP
                ? `tipo=${movEntradaOP.tipo_movimento}, motivo=${movEntradaOP.motivo}, ant=${parseInt(movEntradaOP.saldo_anterior, 10)}, post=${parseInt(movEntradaOP.saldo_posterior, 10)}, doc=${movEntradaOP.documento_ref}`
                : 'Registro não encontrado',
            `tipo=ENTRADA, motivo=PRODUCAO_CONCLUIDA, ant=0, post=100, doc=OP #${opId}`
        );

        // -------------------------------------------------------------------------
        // 3.b) Saída por Venda: Entrega de um pedido de 30 coxinhas
        // -------------------------------------------------------------------------
        console.log('\n   🔹 3.b) Saída por Venda (Entrega de Pedido de 30 coxinhas)');
        const resCliente = mockRes();
        await comercialController.criarCliente(
            {
                body: {
                    razao_social: 'Empório & Buffet Central LTDA',
                    cnpj: '98.765.432/0001-10',
                    telefone: '11988887777',
                    tipo: 'B2B'
                }
            },
            resCliente
        );
        const clienteId = resCliente.body.id;

        const resPedido = mockRes();
        await comercialController.lancarPedido(
            {
                body: {
                    cliente_id: clienteId,
                    data_entrega: '2026-11-02',
                    itens: [{ produto_id: coxinhaId, quantidade: 30, preco_unitario: 5.50 }]
                }
            },
            resPedido
        );
        const pedidoId = resPedido.body.pedido_id;

        // Confirmar entrega do pedido (garantindo que não haja baixa duplicada)
        const resEntrega = mockRes();
        await comercialController.atualizarPedido(
            {
                params: { id: pedidoId },
                body: { status: 'ENTREGUE' }
            },
            resEntrega
        );

        const coxinhaAposVenda = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0];
        const estCoxinhaVenda = parseInt(coxinhaAposVenda.estoque_atual, 10);
        verificar(
            'Estoque de Coxinhas caiu de 100 para 70 un após pedido entregue',
            estCoxinhaVenda === 70,
            `${estCoxinhaVenda} un`,
            '70 un'
        );

        const movSaidaVenda = (await pool.query(
            `SELECT * FROM movimentacao_estoque
             WHERE tipo_estoque = 'PRODUTO_ACABADO'
               AND produto_id = $1
               AND tipo_movimento = 'SAIDA'
               AND motivo = 'VENDA_PEDIDO'
             ORDER BY id DESC LIMIT 1`,
            [coxinhaId]
        )).rows[0];

        verificar(
            'Extrato registrou SAIDA com motivo VENDA_PEDIDO (100 -> 70 un)',
            Boolean(
                movSaidaVenda &&
                movSaidaVenda.tipo_movimento === 'SAIDA' &&
                movSaidaVenda.motivo === 'VENDA_PEDIDO' &&
                aproxIgual(movSaidaVenda.saldo_anterior, 100) &&
                aproxIgual(movSaidaVenda.saldo_posterior, 70)
            ),
            movSaidaVenda
                ? `tipo=${movSaidaVenda.tipo_movimento}, motivo=${movSaidaVenda.motivo}, ant=${parseInt(movSaidaVenda.saldo_anterior, 10)}, post=${parseInt(movSaidaVenda.saldo_posterior, 10)}, doc=${movSaidaVenda.documento_ref}`
                : 'Registro não encontrado',
            `tipo=SAIDA, motivo=VENDA_PEDIDO, ant=100, post=70, doc=Pedido #${pedidoId}`
        );

        // -------------------------------------------------------------------------
        // 3.c) Perda na Câmara Fria: Descarte de 5 coxinhas ('AVARIA_DESCARTE')
        // -------------------------------------------------------------------------
        console.log('\n   🔹 3.c) Perda na Câmara Fria (Descarte de 5 coxinhas — "Avaria por degelo do freezer")');
        const resPerdaCamara = mockRes();
        await estoqueController.registrarMovimentacao(
            {
                body: {
                    tipo_estoque: 'PRODUTO_ACABADO',
                    produto_id: coxinhaId,
                    tipo_movimento: 'PERDA',
                    motivo: 'AVARIA_DESCARTE',
                    quantidade: 5,
                    observacao: 'Avaria por degelo do freezer'
                }
            },
            resPerdaCamara
        );

        const coxinhaAposPerda = (await pool.query('SELECT estoque_atual FROM produto WHERE id = $1', [coxinhaId])).rows[0];
        const estCoxinhaPerda = parseInt(coxinhaAposPerda.estoque_atual, 10);

        const movPerdaCamara = (await pool.query(
            `SELECT * FROM movimentacao_estoque
             WHERE tipo_estoque = 'PRODUTO_ACABADO'
               AND produto_id = $1
               AND tipo_movimento = 'PERDA'
               AND motivo = 'AVARIA_DESCARTE'
             ORDER BY id DESC LIMIT 1`,
            [coxinhaId]
        )).rows[0];

        verificar(
            'Estoque de Coxinhas caiu para 65 un com extrato de PERDA auditado',
            Boolean(
                estCoxinhaPerda === 65 &&
                movPerdaCamara &&
                movPerdaCamara.motivo === 'AVARIA_DESCARTE' &&
                aproxIgual(movPerdaCamara.saldo_anterior, 70) &&
                aproxIgual(movPerdaCamara.saldo_posterior, 65) &&
                movPerdaCamara.observacao === 'Avaria por degelo do freezer'
            ),
            `saldo_atual=${estCoxinhaPerda} un, kardex=[${movPerdaCamara?.tipo_movimento}/${movPerdaCamara?.motivo} ${parseInt(movPerdaCamara?.saldo_anterior || 0, 10)}->${parseInt(movPerdaCamara?.saldo_posterior || 0, 10)}, obs="${movPerdaCamara?.observacao}"]`,
            'saldo_atual=65 un, kardex=[PERDA/AVARIA_DESCARTE 70->65, obs="Avaria por degelo do freezer"]'
        );

        // =========================================================================
        // 4. RESUMO FINAL DA AUDITORIA
        // =========================================================================
        console.log('\n================================================================================');
        console.log(`📊 RESUMO DE VERIFICAÇÕES: ${totalChecks - totalFalhas}/${totalChecks} aprovadas`);
        if (totalFalhas === 0) {
            console.log('🎉 AUDITORIA DO SUBSISTEMA DE ESTOQUE: 100% APROVADO');
            console.log('================================================================================\n');
            process.exitCode = 0;
        } else {
            console.error(`🚨 AUDITORIA REPROVADA COM ${totalFalhas} FALHA(S).`);
            console.log('================================================================================\n');
            process.exitCode = 1;
        }
    } catch (erroFatal) {
        console.error('\n❌ ERRO FATAL DURANTE A EXECUÇÃO DA AUDITORIA:', erroFatal.message);
        console.error(erroFatal);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

executarAuditoriaEstoque();
