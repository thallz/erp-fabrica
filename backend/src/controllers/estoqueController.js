const pool = require('../config/db');
const { recalcularTodasReceitas } = require('../utils/recalcularCustos');

const TIPOS_ESTOQUE_VALIDOS = ['MATERIA_PRIMA', 'PRODUTO_ACABADO'];
const TIPOS_MOVIMENTO_VALIDOS = ['ENTRADA', 'SAIDA', 'AJUSTE', 'PERDA'];

function obterMotivoPadrao(tipoEstoque, tipoMovimento) {
    if (tipoMovimento === 'ENTRADA') {
        return tipoEstoque === 'MATERIA_PRIMA' ? 'COMPRA_FORNECEDOR' : 'ENTRADA_AVULSA';
    }
    if (tipoMovimento === 'SAIDA') return 'SAIDA_AVULSA';
    if (tipoMovimento === 'PERDA') return 'AVARIA_DESCARTE';
    if (tipoMovimento === 'AJUSTE') return 'INVENTARIO_BALANCO';
    return 'MOVIMENTACAO_MANUAL';
}

const estoqueController = {
    /**
     * POST /api/estoque/entrada-nf
     * Entrada integrada de Compra / Nota Fiscal com suporte a MÚLTIPLOS INSUMOS:
     * 1) Itera sobre itens[]: soma saldo em insumo, atualiza custo_unitario/preco_pago e grava Kardex (ENTRADA / COMPRA_FORNECEDOR)
     * 2) Executa recalcularTodasReceitas(client) em cascata para todos os insumos atualizados
     * 3) Gera UM ÚNICO título consolidado em conta_pagar no valor total da NF (PENDENTE se A_PRAZO, PAGO se A_VISTA)
     */
    registrarEntradaNF: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const {
                fornecedor,
                documento_ref,
                data_emissao,
                valor_total_nf,
                pagamento_tipo,
                forma_pagamento = 'BOLETO',
                data_vencimento,
                observacao,
                itens,
                // Compatibilidade retroativa caso enviado item único na raiz
                insumo_id,
                quantidade,
                unidade_medida,
                preco_pago_total
            } = req.body;

            const listaItens = Array.isArray(itens)
                ? itens
                : (insumo_id ? [{ insumo_id, quantidade, unidade_medida, preco_pago_total }] : []);

            const fornecedorLimpo = (fornecedor || '').trim();
            const docRefLimpo = documento_ref && String(documento_ref).trim()
                ? String(documento_ref).trim().slice(0, 100)
                : null;
            const obsLimpa = observacao && String(observacao).trim()
                ? String(observacao).trim()
                : null;
            const dataEmissaoVal = data_emissao && /^\d{4}-\d{2}-\d{2}$/.test(String(data_emissao).trim())
                ? String(data_emissao).trim()
                : null;

            const formaPgtoUpper = String(forma_pagamento || 'BOLETO').trim().toUpperCase();
            const pgtoTipo = pagamento_tipo
                ? String(pagamento_tipo).trim().toUpperCase()
                : (['PIX', 'DINHEIRO', 'CARTAO', 'DEBITO'].includes(formaPgtoUpper) ? 'A_VISTA' : 'A_PRAZO');
            const formaPgto = formaPgtoUpper || (pgtoTipo === 'A_VISTA' ? 'PIX' : 'BOLETO');

            if (!fornecedorLimpo) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Informe o nome do fornecedor da Nota Fiscal.' });
            }
            if (!['A_PRAZO', 'A_VISTA'].includes(pgtoTipo)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Tipo de pagamento inválido. Use A_PRAZO ou A_VISTA.' });
            }
            if (pgtoTipo === 'A_PRAZO' && !data_vencimento) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Data de vencimento é obrigatória para compras a prazo.' });
            }
            if (!listaItens.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Adicione pelo menos um insumo à Nota Fiscal.' });
            }

            let somaItensNF = 0;
            const movimentacoesGeradas = [];
            const resumoItensDescricao = [];

            // 1. Processar cada item da Nota Fiscal
            for (let idx = 0; idx < listaItens.length; idx++) {
                const itemReq = listaItens[idx];
                const numLinha = idx + 1;

                const insumoIdNum = parseInt(itemReq.insumo_id, 10);
                const qtdNum = parseFloat(itemReq.quantidade);
                const valorItemTotal = parseFloat(itemReq.preco_pago_total);

                if (!insumoIdNum || isNaN(insumoIdNum)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        status: 'erro',
                        erro: `Item #${numLinha}: selecione um insumo válido.`
                    });
                }
                if (isNaN(qtdNum) || qtdNum <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        status: 'erro',
                        erro: `Item #${numLinha}: a quantidade comprada deve ser maior que zero.`
                    });
                }
                if (isNaN(valorItemTotal) || valorItemTotal <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        status: 'erro',
                        erro: `Item #${numLinha}: informe o valor total pago pelo item (maior que zero).`
                    });
                }

                // Buscar insumo atual com bloqueio transacional
                const insRes = await client.query(
                    `SELECT id, nome, COALESCE(estoque_atual, 0) AS estoque_atual, unidade_medida, tipo_medida
                     FROM insumo WHERE id = $1 FOR UPDATE`,
                    [insumoIdNum]
                );
                if (insRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({
                        status: 'erro',
                        erro: `Item #${numLinha}: insumo ID ${insumoIdNum} não encontrado no Almoxarifado.`
                    });
                }

                const insumo = insRes.rows[0];
                const saldoAnterior = parseFloat(insumo.estoque_atual || 0);
                const saldoPosterior = saldoAnterior + qtdNum;
                const unidade = insumo.unidade_medida || itemReq.unidade_medida || (insumo.tipo_medida === 'Unidade' ? 'un' : 'kg');
                const isUnidade = insumo.tipo_medida === 'Unidade' || unidade === 'un';

                const novoCustoUnitario = valorItemTotal / qtdNum;
                const pesoEmbSalvar = isUnidade ? qtdNum : (qtdNum * 1000.0);

                // Atualizar saldo, custo unitário e preço pago do insumo
                await client.query(
                    `UPDATE insumo
                     SET estoque_atual = $1,
                         custo_unitario = $2,
                         preco_pago = $3,
                         peso_embalagem = $4
                     WHERE id = $5`,
                    [saldoPosterior, novoCustoUnitario, valorItemTotal, pesoEmbSalvar, insumoIdNum]
                );

                // Gravar entrada individual no Kardex (movimentacao_estoque)
                const obsKardex = obsLimpa
                    ? `${obsLimpa} (Fornecedor: ${fornecedorLimpo})`
                    : `Compra NF${docRefLimpo ? ` ${docRefLimpo}` : ''} — Fornecedor: ${fornecedorLimpo}`;

                const movRes = await client.query(
                    `INSERT INTO movimentacao_estoque (
                        tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                        quantidade, unidade_medida, custo_unitario_momento,
                        saldo_anterior, saldo_posterior, documento_ref, observacao
                    ) VALUES ('MATERIA_PRIMA', $1, NULL, 'ENTRADA', 'COMPRA_FORNECEDOR', $2, $3, $4, $5, $6, $7, $8)
                    RETURNING *`,
                    [
                        insumoIdNum,
                        qtdNum,
                        unidade,
                        novoCustoUnitario,
                        saldoAnterior,
                        saldoPosterior,
                        docRefLimpo,
                        obsKardex
                    ]
                );

                somaItensNF += valorItemTotal;
                movimentacoesGeradas.push(movRes.rows[0]);
                resumoItensDescricao.push(`${qtdNum} ${unidade} ${insumo.nome}`);
            }

            // 2. Recalcular custos de todas as receitas em cascata
            await recalcularTodasReceitas(client);

            // 3. Criar UM ÚNICO título consolidado em conta_pagar
            const valorInformadoNF = parseFloat(valor_total_nf);
            const valorFinalNF = (!isNaN(valorInformadoNF) && valorInformadoNF > 0)
                ? valorInformadoNF
                : Number(somaItensNF.toFixed(2));

            const sufixoNF = docRefLimpo ? ` (${docRefLimpo})` : '';
            let descricaoBase = listaItens.length === 1
                ? `Compra: ${resumoItensDescricao[0]}${sufixoNF}`
                : `Compra (${listaItens.length} itens): ${resumoItensDescricao.join(', ')}${sufixoNF}`;

            if (descricaoBase.length > 200) {
                descricaoBase = descricaoBase.slice(0, 197) + '...';
            }

            const movPrincipalId = movimentacoesGeradas[0]?.id || null;

            let contaRes;
            if (pgtoTipo === 'A_VISTA') {
                contaRes = await client.query(
                    `INSERT INTO conta_pagar (
                        fornecedor, descricao, valor, data_emissao, data_vencimento, data_pagamento,
                        status, forma_pagamento, documento_ref, movimentacao_estoque_id, observacao
                    ) VALUES (
                        $1, $2, $3,
                        COALESCE($4::date, CURRENT_DATE),
                        COALESCE($5::date, COALESCE($4::date, CURRENT_DATE)),
                        CURRENT_DATE,
                        'PAGO', $6, $7, $8, $9
                    ) RETURNING *`,
                    [
                        fornecedorLimpo,
                        descricaoBase,
                        valorFinalNF,
                        dataEmissaoVal,
                        data_vencimento || null,
                        formaPgto,
                        docRefLimpo,
                        movPrincipalId,
                        obsLimpa
                    ]
                );
            } else {
                contaRes = await client.query(
                    `INSERT INTO conta_pagar (
                        fornecedor, descricao, valor, data_emissao, data_vencimento, data_pagamento,
                        status, forma_pagamento, documento_ref, movimentacao_estoque_id, observacao
                    ) VALUES (
                        $1, $2, $3,
                        COALESCE($4::date, CURRENT_DATE),
                        $5::date,
                        NULL,
                        'PENDENTE', $6, $7, $8, $9
                    ) RETURNING *`,
                    [
                        fornecedorLimpo,
                        descricaoBase,
                        valorFinalNF,
                        dataEmissaoVal,
                        data_vencimento,
                        formaPgto,
                        docRefLimpo,
                        movPrincipalId,
                        obsLimpa
                    ]
                );
            }

            await client.query('COMMIT');

            res.status(201).json({
                status: 'sucesso',
                mensagem: `Nota Fiscal${docRefLimpo ? ` ${docRefLimpo}` : ''} lançada! ${movimentacoesGeradas.length} insumo(s) deram entrada no Almoxarifado e 1 título único de R$ ${valorFinalNF.toFixed(2)} (${pgtoTipo === 'A_VISTA' ? 'PAGO' : 'PENDENTE'}) foi gerado em Contas a Pagar.`,
                valor_total_nf: valorFinalNF,
                total_itens: movimentacoesGeradas.length,
                movimentacoes: movimentacoesGeradas,
                movimentacao: movimentacoesGeradas[0] || null,
                conta_pagar: contaRes.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    /**
     * POST /api/estoque/movimentacoes (ou /api/estoque/movimentar)
     * Registra movimentação transacional (Kardex) em Matéria-Prima ou Produto Acabado (Câmara Fria)
     */
    registrarMovimentacao: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            let {
                tipo_estoque,
                insumo_id,
                produto_id,
                tipo_movimento,
                motivo,
                quantidade,
                preco_pago,
                novo_custo_unitario,
                modo_preco,
                documento_ref,
                observacao
            } = req.body;

            // Inferir tipo_estoque caso omitido
            if (!tipo_estoque) {
                if (insumo_id) tipo_estoque = 'MATERIA_PRIMA';
                else if (produto_id) tipo_estoque = 'PRODUTO_ACABADO';
            }

            if (!TIPOS_ESTOQUE_VALIDOS.includes(tipo_estoque)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Tipo de estoque inválido. Use MATERIA_PRIMA ou PRODUTO_ACABADO.'
                });
            }

            if (!TIPOS_MOVIMENTO_VALIDOS.includes(tipo_movimento)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Tipo de movimentação inválido. Use ENTRADA, SAIDA, AJUSTE ou PERDA.'
                });
            }

            const qtdInformada = parseFloat(quantidade);
            if (isNaN(qtdInformada)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Informe uma quantidade numérica válida.'
                });
            }

            if (tipo_movimento === 'AJUSTE') {
                if (qtdInformada < 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        status: 'erro',
                        erro: 'O saldo contado no ajuste de inventário não pode ser negativo.'
                    });
                }
            } else if (qtdInformada <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'A quantidade da movimentação deve ser maior que zero.'
                });
            }

            const motivoFinal = (motivo && String(motivo).trim())
                ? String(motivo).trim().toUpperCase().slice(0, 50)
                : obterMotivoPadrao(tipo_estoque, tipo_movimento);

            const docRefFinal = documento_ref && String(documento_ref).trim()
                ? String(documento_ref).trim().slice(0, 100)
                : null;

            const obsFinal = observacao && String(observacao).trim()
                ? String(observacao).trim()
                : null;

            let saldoAnterior = 0;
            let saldoPosterior = 0;
            let qtdRegistrada = 0;
            let unidadeMedida = 'un';
            let custoMomento = 0;
            let itemNome = '';
            let custoRecalculado = false;
            let insumoIdFinal = null;
            let produtoIdFinal = null;

            // ==========================================================
            // RAMO 1: MATÉRIA-PRIMA (INSUMO — ALMOXARIFADO)
            // ==========================================================
            if (tipo_estoque === 'MATERIA_PRIMA') {
                insumoIdFinal = parseInt(insumo_id, 10);
                if (!insumoIdFinal || isNaN(insumoIdFinal)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ status: 'erro', erro: 'Selecione um insumo válido.' });
                }

                const insRes = await client.query(
                    `SELECT id, nome, COALESCE(estoque_atual, 0) AS estoque_atual, unidade_medida, tipo_medida, custo_unitario
                     FROM insumo WHERE id = $1 FOR UPDATE`,
                    [insumoIdFinal]
                );

                if (insRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ status: 'erro', erro: 'Insumo não encontrado no Almoxarifado.' });
                }

                const insumo = insRes.rows[0];
                itemNome = insumo.nome;
                saldoAnterior = parseFloat(insumo.estoque_atual || 0);
                unidadeMedida = insumo.unidade_medida || (insumo.tipo_medida === 'Unidade' ? 'un' : 'kg');
                custoMomento = parseFloat(insumo.custo_unitario || 0);

                if (tipo_movimento === 'ENTRADA') {
                    saldoPosterior = saldoAnterior + qtdInformada;
                    qtdRegistrada = qtdInformada;
                } else if (tipo_movimento === 'SAIDA' || tipo_movimento === 'PERDA') {
                    if (saldoAnterior + 0.0001 < qtdInformada) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({
                            status: 'erro',
                            erro: `Saldo insuficiente de "${itemNome}". Saldo atual: ${saldoAnterior} ${unidadeMedida}, tentou baixar: ${qtdInformada} ${unidadeMedida}.`
                        });
                    }
                    saldoPosterior = Math.max(0, saldoAnterior - qtdInformada);
                    qtdRegistrada = qtdInformada;
                } else if (tipo_movimento === 'AJUSTE') {
                    saldoPosterior = qtdInformada;
                    qtdRegistrada = Math.abs(saldoPosterior - saldoAnterior);
                }

                // Verificar atualização de custo em ENTRADA de insumo
                const novoCustoDireto = parseFloat(novo_custo_unitario || 0);
                const precoPagoNum = parseFloat(preco_pago || 0);

                if (tipo_movimento === 'ENTRADA' && (novoCustoDireto > 0 || precoPagoNum > 0)) {
                    let custoUnitCalculado = 0;
                    let precoPagoSalvar = 0;
                    let pesoEmbSalvar = 1000;
                    const isUnidade = insumo.tipo_medida === 'Unidade' || unidadeMedida === 'un';

                    if (novoCustoDireto > 0) {
                        custoUnitCalculado = novoCustoDireto;
                        if (precoPagoNum > 0) {
                            precoPagoSalvar = precoPagoNum;
                            pesoEmbSalvar = isUnidade ? qtdInformada : (qtdInformada * 1000.0);
                        } else {
                            precoPagoSalvar = custoUnitCalculado;
                            pesoEmbSalvar = isUnidade ? 1 : 1000;
                        }
                    } else if (precoPagoNum > 0) {
                        if (modo_preco === 'UNITARIO') {
                            custoUnitCalculado = precoPagoNum;
                            precoPagoSalvar = precoPagoNum;
                            pesoEmbSalvar = isUnidade ? 1 : 1000;
                        } else {
                            // Preço total pago na compra para a quantidade informada
                            custoUnitCalculado = precoPagoNum / qtdInformada;
                            precoPagoSalvar = precoPagoNum;
                            pesoEmbSalvar = isUnidade ? qtdInformada : (qtdInformada * 1000.0);
                        }
                    }

                    if (custoUnitCalculado > 0) {
                        custoMomento = custoUnitCalculado;
                        await client.query(
                            `UPDATE insumo
                             SET estoque_atual = $1,
                                 custo_unitario = $2,
                                 preco_pago = $3,
                                 peso_embalagem = $4
                             WHERE id = $5`,
                            [saldoPosterior, custoUnitCalculado, precoPagoSalvar, pesoEmbSalvar, insumoIdFinal]
                        );
                        await recalcularTodasReceitas(client);
                        custoRecalculado = true;
                    } else {
                        await client.query(
                            `UPDATE insumo SET estoque_atual = $1 WHERE id = $2`,
                            [saldoPosterior, insumoIdFinal]
                        );
                    }
                } else {
                    await client.query(
                        `UPDATE insumo SET estoque_atual = $1 WHERE id = $2`,
                        [saldoPosterior, insumoIdFinal]
                    );
                }
            }
            // ==========================================================
            // RAMO 2: PRODUTO ACABADO (SALGADOS CONGELADOS — CÂMARA FRIA)
            // ==========================================================
            else {
                produtoIdFinal = parseInt(produto_id, 10);
                if (!produtoIdFinal || isNaN(produtoIdFinal)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ status: 'erro', erro: 'Selecione um produto válido da Câmara Fria.' });
                }

                const qtdInt = Math.round(qtdInformada);

                const prodRes = await client.query(
                    `SELECT p.id, p.nome, COALESCE(p.estoque_atual, 0) AS estoque_atual,
                            COALESCE(p.cmv_estimado, 0) AS cmv_estimado,
                            COALESCE(p.rateio_embalagem, 0) AS rateio_embalagem,
                            COALESCE((
                                SELECT SUM(ftr.quantidade_necessaria * r.custo_por_kg)
                                FROM ficha_tecnica_receita ftr
                                JOIN receita r ON r.id = ftr.receita_id
                                WHERE ftr.produto_id = p.id
                            ), 0) AS custo_ingredientes
                     FROM produto p
                     WHERE p.id = $1 FOR UPDATE`,
                    [produtoIdFinal]
                );

                if (prodRes.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ status: 'erro', erro: 'Produto não encontrado na Câmara Fria.' });
                }

                const produto = prodRes.rows[0];
                itemNome = produto.nome;
                saldoAnterior = parseInt(produto.estoque_atual || 0, 10);
                unidadeMedida = 'un';

                const custoFicha = parseFloat(produto.custo_ingredientes || 0) + parseFloat(produto.rateio_embalagem || 0);
                custoMomento = custoFicha > 0 ? custoFicha : parseFloat(produto.cmv_estimado || 0);

                if (tipo_movimento === 'ENTRADA') {
                    saldoPosterior = saldoAnterior + qtdInt;
                    qtdRegistrada = qtdInt;
                } else if (tipo_movimento === 'SAIDA' || tipo_movimento === 'PERDA') {
                    if (saldoAnterior < qtdInt) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({
                            status: 'erro',
                            erro: `Saldo insuficiente na Câmara Fria para "${itemNome}". Saldo atual: ${saldoAnterior} un, tentou baixar: ${qtdInt} un.`
                        });
                    }
                    saldoPosterior = saldoAnterior - qtdInt;
                    qtdRegistrada = qtdInt;
                } else if (tipo_movimento === 'AJUSTE') {
                    saldoPosterior = qtdInt;
                    qtdRegistrada = Math.abs(saldoPosterior - saldoAnterior);
                }

                await client.query(
                    `UPDATE produto SET estoque_atual = $1 WHERE id = $2`,
                    [saldoPosterior, produtoIdFinal]
                );
            }

            // Inserir registro de auditoria no Kardex (movimentacao_estoque)
            const movInsert = await client.query(
                `INSERT INTO movimentacao_estoque (
                    tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                    quantidade, unidade_medida, custo_unitario_momento,
                    saldo_anterior, saldo_posterior, documento_ref, observacao
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                RETURNING *`,
                [
                    tipo_estoque,
                    insumoIdFinal,
                    produtoIdFinal,
                    tipo_movimento,
                    motivoFinal,
                    qtdRegistrada,
                    unidadeMedida,
                    custoMomento,
                    saldoAnterior,
                    saldoPosterior,
                    docRefFinal,
                    obsFinal
                ]
            );

            await client.query('COMMIT');

            res.status(201).json({
                status: 'sucesso',
                mensagem: `Movimentação (${tipo_movimento}) registrada com sucesso para "${itemNome}"!`,
                item_nome: itemNome,
                saldo_anterior: saldoAnterior,
                saldo_posterior: saldoPosterior,
                custo_recalculado: custoRecalculado,
                movimentacao: movInsert.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    /**
     * GET /api/estoque/extrato
     * Retorna histórico paginado e filtrado de movimentações (MATERIA_PRIMA ou PRODUTO_ACABADO)
     */
    listarExtrato: async (req, res) => {
        try {
            const {
                tipo_estoque,
                insumo_id,
                produto_id,
                item_id,
                tipo_movimento,
                data_inicio,
                data_fim,
                page = 1,
                limit = 25
            } = req.query;

            const params = [];
            const where = [];

            if (tipo_estoque && TIPOS_ESTOQUE_VALIDOS.includes(tipo_estoque)) {
                params.push(tipo_estoque);
                where.push(`m.tipo_estoque = $${params.length}`);
            }

            const filtroInsumo = insumo_id || (tipo_estoque === 'MATERIA_PRIMA' ? item_id : null);
            if (filtroInsumo && !isNaN(parseInt(filtroInsumo, 10))) {
                params.push(parseInt(filtroInsumo, 10));
                where.push(`m.insumo_id = $${params.length}`);
            }

            const filtroProduto = produto_id || (tipo_estoque === 'PRODUTO_ACABADO' ? item_id : null);
            if (filtroProduto && !isNaN(parseInt(filtroProduto, 10))) {
                params.push(parseInt(filtroProduto, 10));
                where.push(`m.produto_id = $${params.length}`);
            }

            if (tipo_movimento && TIPOS_MOVIMENTO_VALIDOS.includes(tipo_movimento)) {
                params.push(tipo_movimento);
                where.push(`m.tipo_movimento = $${params.length}`);
            }

            if (data_inicio && /^\d{4}-\d{2}-\d{2}$/.test(data_inicio)) {
                params.push(data_inicio);
                where.push(`m.criado_em >= ($${params.length}::date)`);
            }

            if (data_fim && /^\d{4}-\d{2}-\d{2}$/.test(data_fim)) {
                params.push(data_fim);
                where.push(`m.criado_em < (($${params.length}::date) + INTERVAL '1 day')`);
            }

            const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

            const paginaAtual = Math.max(1, parseInt(page, 10) || 1);
            const porPagina = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
            const offset = (paginaAtual - 1) * porPagina;

            const countRes = await pool.query(
                `SELECT COUNT(*)::int AS total FROM movimentacao_estoque m ${whereSql}`,
                params
            );
            const total = countRes.rows[0]?.total || 0;
            const totalPaginas = Math.max(1, Math.ceil(total / porPagina));

            const dataParams = [...params, porPagina, offset];
            const rowsRes = await pool.query(
                `SELECT
                    m.id,
                    m.tipo_estoque,
                    m.insumo_id,
                    m.produto_id,
                    COALESCE(i.nome, p.nome, 'Item removido') AS item_nome,
                    COALESCE(i.categoria, p.categoria, 'Geral') AS item_categoria,
                    m.tipo_movimento,
                    m.motivo,
                    m.quantidade,
                    m.unidade_medida,
                    m.custo_unitario_momento,
                    m.saldo_anterior,
                    m.saldo_posterior,
                    m.documento_ref,
                    m.observacao,
                    m.criado_em
                 FROM movimentacao_estoque m
                 LEFT JOIN insumo i ON i.id = m.insumo_id
                 LEFT JOIN produto p ON p.id = m.produto_id
                 ${whereSql}
                 ORDER BY m.criado_em DESC, m.id DESC
                 LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
                dataParams
            );

            res.json({
                status: 'sucesso',
                dados: rowsRes.rows,
                paginacao: {
                    total,
                    pagina_atual: paginaAtual,
                    por_pagina: porPagina,
                    total_paginas: totalPaginas
                }
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    }
};

module.exports = estoqueController;
