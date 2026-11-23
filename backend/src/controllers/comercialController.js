const pool = require('../config/db');

function erroValidacao(mensagem, statusCode = 400) {
    const err = new Error(mensagem);
    err.statusCode = statusCode;
    return err;
}

/**
 * Consolida eventuais itens repetidos do mesmo produto_id na mesma lista
 */
function consolidarItensPorProduto(itens) {
    const mapa = new Map();
    for (const raw of itens || []) {
        const prodId = parseInt(raw.produto_id, 10);
        const qtd = parseInt(raw.quantidade, 10);
        const preco = parseFloat(raw.preco_unitario);
        if (!prodId || isNaN(prodId) || isNaN(qtd) || qtd <= 0 || isNaN(preco) || preco < 0) {
            continue;
        }
        if (mapa.has(prodId)) {
            const existente = mapa.get(prodId);
            existente.quantidade += qtd;
            existente.preco_unitario = preco;
        } else {
            mapa.set(prodId, { produto_id: prodId, quantidade: qtd, preco_unitario: preco });
        }
    }
    return Array.from(mapa.values()).sort((a, b) => a.produto_id - b.produto_id);
}

/**
 * Calcula o balanço global de um produto e a necessidade de geração de OP para ENTREGA,
 * ou valida o saldo físico livre para RETIRADA.
 * Deve ser chamado dentro de transação com o produto travado (FOR UPDATE).
 */
async function avaliarDisponibilidadeProduto(client, produto, qtdSolicitada, tipoPedido) {
    const estoqueFisico = parseInt(produto.estoque_atual, 10) || 0;

    if (tipoPedido === 'RETIRADA') {
        const resRet = await client.query(
            `SELECT COALESCE(SUM(ip.quantidade), 0)::int AS reservado
             FROM item_pedido ip
             JOIN pedido ped ON ped.id = ip.pedido_id
             WHERE ip.produto_id = $1
               AND ped.tipo_pedido = 'RETIRADA'
               AND ped.status = 'ABERTO'
               AND ped.estoque_baixado = FALSE`,
            [produto.id]
        );
        const reservadoRetirada = parseInt(resRet.rows[0]?.reservado || 0, 10);
        const disponivelLivre = Math.max(0, estoqueFisico - reservadoRetirada);
        if (disponivelLivre < qtdSolicitada) {
            throw erroValidacao(
                `Saldo insuficiente na Câmara Fria para retirada imediata de "${produto.nome}": disponível ${disponivelLivre} un, solicitado ${qtdSolicitada} un.`
            );
        }
        return { faltaProduzir: 0, cobertura: disponivelLivre };
    }

    // Balanço Global para ENTREGA: Estoque Físico + OPs abertas - Demanda de Pedidos abertos
    const opsRes = await client.query(
        `SELECT COALESCE(SUM(quantidade_planejada), 0)::int AS total_ops
         FROM ordem_producao
         WHERE produto_id = $1
           AND status IN ('FILA', 'PRODUZINDO')
           AND COALESCE(tipo_op, 'MONTAGEM') = 'MONTAGEM'`,
        [produto.id]
    );
    const opsAbertas = parseInt(opsRes.rows[0]?.total_ops || 0, 10);

    const demRes = await client.query(
        `SELECT COALESCE(SUM(ip.quantidade), 0)::int AS total_demanda
         FROM item_pedido ip
         JOIN pedido ped ON ped.id = ip.pedido_id
         WHERE ip.produto_id = $1
           AND ped.status = 'ABERTO'
           AND ped.estoque_baixado = FALSE`,
        [produto.id]
    );
    const demandaAbertos = parseInt(demRes.rows[0]?.total_demanda || 0, 10);

    const cobertura = estoqueFisico + opsAbertas - demandaAbertos;
    const faltaProduzir = Math.max(0, qtdSolicitada - Math.max(0, cobertura));
    return { faltaProduzir, cobertura };
}

/**
 * Cria 1 OP de MONTAGEM na fila para a quantidade faltante e vincula ao pedido.
 */
async function criarOPParaPedido(client, { pedidoId, clienteId, produto, quantidadeFaltante, dataEntrega, avisos = [] }) {
    const ficha = await client.query(
        `SELECT
            (SELECT COUNT(*)::int FROM ficha_tecnica_insumo WHERE produto_id = $1) +
            (SELECT COUNT(*)::int FROM ficha_tecnica_embalagem WHERE produto_id = $1) +
            (SELECT COUNT(*)::int FROM ficha_tecnica_receita WHERE produto_id = $1) AS total`,
        [produto.id]
    );
    if (ficha.rows[0].total === 0 && !produto.embalagem_id) {
        avisos.push(`"${produto.nome}": faltam ${quantidadeFaltante} un, mas não há ficha técnica cadastrada.`);
    }

    const opResult = await client.query(
        `INSERT INTO ordem_producao (produto_id, quantidade_planejada, status, categoria_producao, tipo_op, pedido_id)
         VALUES ($1, $2, 'FILA', $3, 'MONTAGEM', $4) RETURNING id`,
        [produto.id, quantidadeFaltante, produto.categoria_producao || produto.categoria || 'Geral', pedidoId]
    );
    const opId = opResult.rows[0].id;

    await client.query(
        `INSERT INTO ordem_producao_origem (ordem_producao_id, pedido_id, cliente_id, quantidade, data_entrega)
         VALUES ($1, $2, $3, $4, $5)`,
        [opId, pedidoId, clienteId, quantidadeFaltante, dataEntrega || null]
    );

    return {
        op_id: opId,
        pedido_id: pedidoId,
        produto_id: produto.id,
        produto: produto.nome,
        quantidade_planejada: quantidadeFaltante
    };
}

/**
 * Remove ou abate OPs ainda não concluídas vinculadas a um pedido (usado em editarPedido e cancelarPedido).
 */
async function limparOPsNaoConcluidasDoPedido(client, pedidoId) {
    const opsRes = await client.query(
        `SELECT op.id, op.status, op.quantidade_planejada, op.pedido_id, COALESCE(op.agrupada, FALSE) AS agrupada
         FROM ordem_producao op
         WHERE op.status <> 'CONCLUIDA'
           AND (
             op.pedido_id = $1
             OR EXISTS (
               SELECT 1 FROM ordem_producao_origem opo
               WHERE opo.ordem_producao_id = op.id AND opo.pedido_id = $1
             )
           )
         FOR UPDATE`,
        [pedidoId]
    );

    for (const op of opsRes.rows) {
        const outrasOrigens = await client.query(
            `SELECT id, quantidade FROM ordem_producao_origem
             WHERE ordem_producao_id = $1 AND (pedido_id IS NULL OR pedido_id <> $2)`,
            [op.id, pedidoId]
        );

        if (outrasOrigens.rows.length === 0) {
            await client.query('DELETE FROM ordem_producao WHERE id = $1', [op.id]);
        } else {
            const minhasOrigens = await client.query(
                `SELECT COALESCE(SUM(quantidade), 0)::int AS qtd_minha
                 FROM ordem_producao_origem
                 WHERE ordem_producao_id = $1 AND pedido_id = $2`,
                [op.id, pedidoId]
            );
            const qtdRemover = parseInt(minhasOrigens.rows[0]?.qtd_minha || 0, 10);
            await client.query(
                'DELETE FROM ordem_producao_origem WHERE ordem_producao_id = $1 AND pedido_id = $2',
                [op.id, pedidoId]
            );
            const novaQtd = Math.max(0, parseInt(op.quantidade_planejada, 10) - qtdRemover);
            if (novaQtd <= 0) {
                await client.query('DELETE FROM ordem_producao WHERE id = $1', [op.id]);
            } else {
                await client.query(
                    'UPDATE ordem_producao SET quantidade_planejada = $1, pedido_id = NULL WHERE id = $2',
                    [novaQtd, op.id]
                );
            }
        }
    }
}

/**
 * Lógica transacional central de lançamento de Pedido de Venda:
 * - NÃO baixa Câmara Fria e NÃO gera Contas a Receber na criação.
 * - Valida saldo livre em RETIRADA ou usa Balanço Global em ENTREGA para gerar OP apenas do que falta.
 */
async function processarLancamentoPedidoTransacional(client, {
    cliente_id,
    data_entrega,
    itens,
    tipo_pedido = 'ENTREGA',
    observacao = null
}) {
    const itensConsolidados = consolidarItensPorProduto(itens || []);
    if (!itensConsolidados.length) {
        throw erroValidacao('Informe pelo menos um item válido no pedido.');
    }

    const clienteIdNum = parseInt(cliente_id, 10);
    if (!clienteIdNum || isNaN(clienteIdNum)) {
        throw erroValidacao('Selecione um cliente válido.');
    }

    const cliRes = await client.query(
        'SELECT id, razao_social FROM cliente WHERE id = $1',
        [clienteIdNum]
    );
    if (cliRes.rows.length === 0) {
        throw erroValidacao(`Cliente ID ${clienteIdNum} não encontrado.`, 404);
    }

    const tipoPedidoFinal = String(tipo_pedido || 'ENTREGA').trim().toUpperCase() === 'RETIRADA' ? 'RETIRADA' : 'ENTREGA';
    const dataEntregaLimpa = data_entrega && String(data_entrega).trim() ? String(data_entrega).trim() : null;
    if (tipoPedidoFinal === 'ENTREGA' && !dataEntregaLimpa) {
        throw erroValidacao('Informe a data de entrega prevista para pedidos de entrega.');
    }

    const valorTotal = Number(
        itensConsolidados.reduce((acc, it) => acc + it.quantidade * it.preco_unitario, 0).toFixed(2)
    );
    const obsLimpa = observacao && String(observacao).trim() ? String(observacao).trim() : null;

    const resultPedido = await client.query(
        `INSERT INTO pedido (cliente_id, data_entrega, valor_total, status, tipo_pedido, estoque_baixado, faturado, observacao)
         VALUES ($1, $2, $3, 'ABERTO', $4, FALSE, FALSE, $5) RETURNING id`,
        [clienteIdNum, dataEntregaLimpa, valorTotal, tipoPedidoFinal, obsLimpa]
    );
    const pedidoId = resultPedido.rows[0].id;

    const opsGeradas = [];
    const avisos = [];

    for (const item of itensConsolidados) {
        const prodResult = await client.query(
            `SELECT id, nome, COALESCE(estoque_atual, 0) AS estoque_atual,
                    categoria, categoria_producao, embalagem_id
             FROM produto WHERE id = $1 FOR UPDATE`,
            [item.produto_id]
        );
        if (prodResult.rows.length === 0) {
            throw erroValidacao(`Produto ID ${item.produto_id} não encontrado.`, 404);
        }
        const produto = prodResult.rows[0];

        const { faltaProduzir } = await avaliarDisponibilidadeProduto(client, produto, item.quantidade, tipoPedidoFinal);

        await client.query(
            'INSERT INTO item_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
            [pedidoId, item.produto_id, item.quantidade, item.preco_unitario]
        );

        if (tipoPedidoFinal === 'ENTREGA' && faltaProduzir > 0) {
            const opGerada = await criarOPParaPedido(client, {
                pedidoId,
                clienteId: clienteIdNum,
                produto,
                quantidadeFaltante: faltaProduzir,
                dataEntrega: dataEntregaLimpa,
                avisos
            });
            opsGeradas.push(opGerada);
        }
    }

    return {
        pedidoId,
        tipoPedido: tipoPedidoFinal,
        valorTotal,
        statusPedido: 'ABERTO',
        opsGeradas,
        avisos
    };
}

/**
 * Calcula em memória a prioridade dinâmica de estoque físico por data de entrega,
 * status_fluxo, itens_faltantes, pode_editar e contas a receber vinculadas.
 */
async function calcularEstadoPedidos(db) {
    const prodsRes = await db.query('SELECT id, nome, COALESCE(estoque_atual, 0)::int AS estoque_atual FROM produto');
    const saldoSimulado = {};
    for (const p of prodsRes.rows) {
        saldoSimulado[p.id] = parseInt(p.estoque_atual || 0, 10);
    }

    const pedidosRes = await db.query(`
        SELECT p.id, p.cliente_id, p.data_pedido,
               TO_CHAR(p.data_entrega, 'YYYY-MM-DD') AS data_entrega,
               p.status, p.valor_total, p.tipo_pedido, p.estoque_baixado,
               p.data_entrega_efetiva, p.faturado, p.observacao,
               c.razao_social, c.cnpj, c.telefone, c.endereco,
               COALESCE(c.saldo_credito, 0)::numeric(10,2) AS saldo_credito
        FROM pedido p
        JOIN cliente c ON c.id = p.cliente_id
        WHERE p.status <> 'ORCAMENTO'
        ORDER BY
            CASE WHEN p.status = 'ABERTO' THEN 0 ELSE 1 END ASC,
            CASE WHEN p.tipo_pedido = 'RETIRADA' THEN 0 ELSE 1 END ASC,
            COALESCE(p.data_entrega, '9999-12-31') ASC,
            p.id ASC
    `);

    const itensRes = await db.query(`
        SELECT ip.pedido_id, ip.produto_id, ip.quantidade, ip.preco_unitario,
               COALESCE(ip.quantidade_avariada, 0)::int AS quantidade_avariada,
               pr.nome AS produto_nome, COALESCE(pr.estoque_atual, 0)::int AS estoque_fisico_atual
        FROM item_pedido ip
        JOIN produto pr ON pr.id = ip.produto_id
        ORDER BY ip.pedido_id ASC, pr.nome ASC
    `);

    const itensPorPedido = {};
    for (const it of itensRes.rows) {
        if (!itensPorPedido[it.pedido_id]) itensPorPedido[it.pedido_id] = [];
        itensPorPedido[it.pedido_id].push(it);
    }

    const crRes = await db.query(`
        SELECT id, pedido_id, valor, credito_utilizado,
               TO_CHAR(data_vencimento, 'YYYY-MM-DD') AS data_vencimento,
               TO_CHAR(data_recebimento, 'YYYY-MM-DD') AS data_recebimento,
               status, forma_pagamento, documento_ref
        FROM conta_receber
        WHERE pedido_id IS NOT NULL
        ORDER BY CASE WHEN status = 'CANCELADO' THEN 1 ELSE 0 END ASC, id DESC
    `);
    const crPorPedido = {};
    for (const cr of crRes.rows) {
        if (!crPorPedido[cr.pedido_id]) crPorPedido[cr.pedido_id] = cr;
    }

    const opsRes = await db.query(`
        SELECT DISTINCT
            COALESCE(opo.pedido_id, op.pedido_id) AS pedido_id,
            op.id AS op_id,
            op.produto_id,
            op.quantidade_planejada,
            op.status,
            op.colaborador_id,
            TO_CHAR(op.data_programada, 'YYYY-MM-DD') AS data_programada
        FROM ordem_producao op
        LEFT JOIN ordem_producao_origem opo ON opo.ordem_producao_id = op.id
        WHERE COALESCE(opo.pedido_id, op.pedido_id) IS NOT NULL
        ORDER BY op.id ASC
    `);
    const opsPorPedido = {};
    for (const op of opsRes.rows) {
        if (!opsPorPedido[op.pedido_id]) opsPorPedido[op.pedido_id] = [];
        opsPorPedido[op.pedido_id].push(op);
    }

    const resultado = [];
    for (const p of pedidosRes.rows) {
        const itens = itensPorPedido[p.id] || [];
        const cr = crPorPedido[p.id] || null;
        const ops = opsPorPedido[p.id] || [];

        let statusFluxo = p.status;
        const itensFaltantes = [];

        if (p.status === 'ABERTO') {
            for (const it of itens) {
                const disp = Math.max(0, saldoSimulado[it.produto_id] ?? 0);
                if (disp < it.quantidade) {
                    itensFaltantes.push({
                        produto_id: it.produto_id,
                        produto_nome: it.produto_nome,
                        pedido_qtd: it.quantidade,
                        disponivel_fisico: disp,
                        falta: it.quantidade - disp
                    });
                }
            }
            if (itensFaltantes.length === 0 && itens.length > 0) {
                statusFluxo = 'PRONTO_ENTREGA';
                for (const it of itens) {
                    saldoSimulado[it.produto_id] = Math.max(0, (saldoSimulado[it.produto_id] ?? 0) - it.quantidade);
                }
            } else {
                statusFluxo = 'AGUARDANDO_PRODUCAO';
            }
        } else if (p.status === 'ENTREGUE') {
            if (!p.faturado) {
                statusFluxo = 'ENTREGUE_AGUARDANDO_FATURAMENTO';
            } else if (!cr || cr.status !== 'RECEBIDO') {
                statusFluxo = 'ENTREGUE_AGUARDANDO_PAGAMENTO';
            } else {
                statusFluxo = 'CONCLUIDO';
            }
        }

        const temOpProgramada = ops.some(o => o.colaborador_id !== null && o.data_programada !== null && o.status !== 'CONCLUIDA');
        let podeEditar = true;
        let motivoBloqueioEdicao = null;

        if (p.status !== 'ABERTO' || p.estoque_baixado || p.faturado) {
            podeEditar = false;
            motivoBloqueioEdicao = 'Pedido já entregue, faturado ou encerrado.';
        } else if (temOpProgramada) {
            podeEditar = false;
            motivoBloqueioEdicao = 'Existe OP deste pedido já programada no Planejamento de Produção.';
        }

        resultado.push({
            ...p,
            valor_total: parseFloat(p.valor_total || 0),
            saldo_credito: parseFloat(p.saldo_credito || 0),
            total_itens: itens.length,
            total_unidades: itens.reduce((acc, it) => acc + parseInt(it.quantidade, 10), 0),
            status_fluxo: statusFluxo,
            itens_faltantes: itensFaltantes,
            pode_editar: podeEditar,
            motivo_bloqueio_edicao: motivoBloqueioEdicao,
            conta_receber: cr,
            itens,
            ops
        });
    }

    return resultado;
}

const comercialController = {
    // 1. CRIAR CLIENTE B2B
    criarCliente: async (req, res) => {
        try {
            const { razao_social, cnpj, telefone, endereco, tipo } = req.body;
            const novoCliente = await pool.query(
                'INSERT INTO cliente (razao_social, cnpj, telefone, endereco, tipo) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [razao_social, cnpj || '', telefone || '', endereco || '', tipo || 'B2B']
            );
            res.status(201).json(novoCliente.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2. LISTAR CLIENTES
    listarClientes: async (req, res) => {
        try {
            const clientes = await pool.query(
                `SELECT id, razao_social, cnpj, telefone, endereco, tipo,
                        COALESCE(saldo_credito, 0)::numeric(10,2) AS saldo_credito,
                        criado_em
                 FROM cliente ORDER BY razao_social ASC`
            );
            res.json(clientes.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2b. ATUALIZAR CLIENTE
    atualizarCliente: async (req, res) => {
        try {
            const { id } = req.params;
            const { razao_social, cnpj, telefone, endereco, tipo } = req.body;
            const result = await pool.query(
                'UPDATE cliente SET razao_social = $1, cnpj = $2, telefone = $3, endereco = $4, tipo = $5 WHERE id = $6 RETURNING *',
                [razao_social, cnpj || '', telefone || '', endereco || '', tipo || 'B2B', id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Cliente não encontrado' });
            }
            res.json(result.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 2c. EXCLUIR CLIENTE
    excluirCliente: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM cliente WHERE id = $1 RETURNING id', [id]);
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Cliente não encontrado' });
            }
            res.json({ status: 'sucesso', id: result.rows[0].id });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. LISTAR PEDIDOS (com prioridade dinâmica por data_entrega e status_fluxo)
    listarPedidos: async (req, res) => {
        try {
            const pedidos = await calcularEstadoPedidos(pool);
            // Ordenar lista final com mais recentes primeiro ou abertos prioritários no topo:
            pedidos.sort((a, b) => {
                const rankA = a.status === 'ABERTO' ? 0 : a.status === 'ENTREGUE' ? 1 : 2;
                const rankB = b.status === 'ABERTO' ? 0 : b.status === 'ENTREGUE' ? 1 : 2;
                if (rankA !== rankB) return rankA - rankB;
                if (a.status === 'ABERTO') {
                    const da = a.data_entrega || '9999-12-31';
                    const db = b.data_entrega || '9999-12-31';
                    if (da !== db) return da.localeCompare(db);
                }
                return b.id - a.id;
            });
            res.json(pedidos);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3b. DETALHE DO PEDIDO
    obterPedido: async (req, res) => {
        try {
            const idNum = parseInt(req.params.id, 10);
            const pedidos = await calcularEstadoPedidos(pool);
            const ped = pedidos.find(p => p.id === idNum);
            if (!ped) {
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado' });
            }

            const ocorrenciasRes = await pool.query(
                `SELECT oe.*, pr.nome AS produto_nome
                 FROM ocorrencia_entrega oe
                 JOIN produto pr ON pr.id = oe.produto_id
                 WHERE oe.pedido_id = $1
                 ORDER BY oe.id DESC`,
                [idNum]
            );

            res.json({
                ...ped,
                ocorrencias: ocorrenciasRes.rows
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3c. EDITAR PEDIDO (PUT /api/comercial/pedidos/:id)
    editarPedido: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const { data_entrega, tipo_pedido, observacao, itens } = req.body || {};

            const pedRes = await client.query('SELECT * FROM pedido WHERE id = $1 FOR UPDATE', [id]);
            if (pedRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado.' });
            }
            const ped = pedRes.rows[0];

            if (ped.status !== 'ABERTO' || ped.estoque_baixado || ped.faturado) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Pedido não pode ser editado após entrega, faturamento ou cancelamento.'
                });
            }

            const opsVinculadas = await client.query(
                `SELECT op.id, op.status, op.colaborador_id, op.data_programada
                 FROM ordem_producao op
                 WHERE op.pedido_id = $1
                    OR EXISTS (
                      SELECT 1 FROM ordem_producao_origem opo
                      WHERE opo.ordem_producao_id = op.id AND opo.pedido_id = $1
                    )
                 FOR UPDATE`,
                [id]
            );

            const temOpProgramada = opsVinculadas.rows.some(
                o => o.colaborador_id !== null && o.data_programada !== null && o.status !== 'CONCLUIDA'
            );
            if (temOpProgramada) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Edição bloqueada: existe OP deste pedido já programada no Planejamento de Produção.'
                });
            }

            const todasOpsConcluidas = opsVinculadas.rows.length > 0 &&
                opsVinculadas.rows.every(o => o.status === 'CONCLUIDA');

            const oldItensRes = await client.query(
                'SELECT produto_id, quantidade, preco_unitario FROM item_pedido WHERE pedido_id = $1',
                [id]
            );
            const oldQtdMap = {};
            for (const row of oldItensRes.rows) {
                oldQtdMap[row.produto_id] = parseInt(row.quantidade, 10);
            }

            const itensNovos = itens ? consolidarItensPorProduto(itens) : consolidarItensPorProduto(oldItensRes.rows);
            if (!itensNovos.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'O pedido precisa ter pelo menos um item válido.' });
            }

            const tipoPedidoFinal = tipo_pedido
                ? (String(tipo_pedido).trim().toUpperCase() === 'RETIRADA' ? 'RETIRADA' : 'ENTREGA')
                : (ped.tipo_pedido || 'ENTREGA');

            const dataEntregaFinal = data_entrega !== undefined
                ? (data_entrega && String(data_entrega).trim() ? String(data_entrega).trim() : null)
                : ped.data_entrega;

            if (tipoPedidoFinal === 'ENTREGA' && !dataEntregaFinal) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Informe a data de entrega.' });
            }

            const obsFinal = observacao !== undefined
                ? (observacao && String(observacao).trim() ? String(observacao).trim() : null)
                : ped.observacao;

            // Remover OPs não concluídas vinculadas para recalcular pelo novo balanço global
            if (!todasOpsConcluidas) {
                await limparOPsNaoConcluidasDoPedido(client, ped.id);
            }

            // Remover itens antigos temporariamente para o balanço global não somá-los em duplicidade
            await client.query('DELETE FROM item_pedido WHERE pedido_id = $1', [id]);

            const opsGeradas = [];
            const avisos = [];
            let valorTotal = 0;

            for (const item of itensNovos) {
                valorTotal += item.quantidade * item.preco_unitario;

                const prodRes = await client.query(
                    `SELECT id, nome, COALESCE(estoque_atual, 0) AS estoque_atual,
                            categoria, categoria_producao, embalagem_id
                     FROM produto WHERE id = $1 FOR UPDATE`,
                    [item.produto_id]
                );
                if (prodRes.rows.length === 0) {
                    throw erroValidacao(`Produto ID ${item.produto_id} não encontrado.`, 404);
                }
                const produto = prodRes.rows[0];

                const { faltaProduzir } = await avaliarDisponibilidadeProduto(client, produto, item.quantidade, tipoPedidoFinal);

                if (todasOpsConcluidas && item.quantidade > (oldQtdMap[item.produto_id] || 0) && faltaProduzir > 0) {
                    throw erroValidacao(
                        `Todas as OPs deste pedido já foram concluídas. Não há saldo livre suficiente na Câmara Fria para aumentar "${produto.nome}" (faltam ${faltaProduzir} un).`
                    );
                }

                await client.query(
                    'INSERT INTO item_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
                    [ped.id, item.produto_id, item.quantidade, item.preco_unitario]
                );

                if (!todasOpsConcluidas && tipoPedidoFinal === 'ENTREGA' && faltaProduzir > 0) {
                    const opGerada = await criarOPParaPedido(client, {
                        pedidoId: ped.id,
                        clienteId: ped.cliente_id,
                        produto,
                        quantidadeFaltante: faltaProduzir,
                        dataEntrega: dataEntregaFinal,
                        avisos
                    });
                    opsGeradas.push(opGerada);
                }
            }

            const updated = await client.query(
                `UPDATE pedido
                 SET data_entrega = $1,
                     tipo_pedido = $2,
                     observacao = $3,
                     valor_total = $4
                 WHERE id = $5
                 RETURNING *`,
                [dataEntregaFinal, tipoPedidoFinal, obsFinal, Number(valorTotal.toFixed(2)), ped.id]
            );

            await client.query('COMMIT');
            res.json({
                status: 'sucesso',
                mensagem: `Pedido #${ped.id} atualizado com sucesso!`,
                pedido: updated.rows[0],
                ops_geradas: opsGeradas,
                avisos
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(error.statusCode || 500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 4. LANÇAR PEDIDO (Sem baixa de Câmara Fria nem cobrança antecipada)
    lancarPedido: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const {
                cliente_id,
                data_entrega,
                itens,
                tipo_pedido = 'ENTREGA',
                observacao = null
            } = req.body;

            if (!itens || !itens.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Pedido sem itens.' });
            }

            const resultado = await processarLancamentoPedidoTransacional(client, {
                cliente_id,
                data_entrega,
                itens,
                tipo_pedido,
                observacao
            });

            await client.query('COMMIT');

            let mensagem = resultado.tipoPedido === 'RETIRADA'
                ? `Pedido #${resultado.pedidoId} (Retirada Imediata) registrado — pronto para entrega!`
                : `Pedido #${resultado.pedidoId} lançado com sucesso!`;
            if (resultado.opsGeradas.length) {
                mensagem += ` ${resultado.opsGeradas.length} OP(s) gerada(s) na fila para o que falta produzir.`;
            }

            res.status(201).json({
                status: 'sucesso',
                pedido_id: resultado.pedidoId,
                tipo_pedido: resultado.tipoPedido,
                mensagem,
                ops_geradas: resultado.opsGeradas,
                avisos: resultado.avisos
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(error.statusCode || 500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 4b. ENTREGAR PEDIDO (Baixa física definitiva na Câmara Fria + Kardex) — POST /api/comercial/pedidos/:id/entregar
    entregarPedido: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;

            const pedRes = await client.query('SELECT * FROM pedido WHERE id = $1 FOR UPDATE', [id]);
            if (pedRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado.' });
            }
            const ped = pedRes.rows[0];

            if (ped.status !== 'ABERTO' || ped.estoque_baixado) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: `Pedido #${id} não pode ser entregue (status atual: ${ped.status}, estoque_baixado: ${ped.estoque_baixado}).`
                });
            }

            const itensRes = await client.query(
                `SELECT ip.produto_id, ip.quantidade, pr.nome AS produto_nome
                 FROM item_pedido ip
                 JOIN produto pr ON pr.id = ip.produto_id
                 WHERE ip.pedido_id = $1
                 ORDER BY ip.produto_id ASC`,
                [id]
            );
            if (itensRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Pedido sem itens para entregar.' });
            }

            // Validar saldo físico para 100% dos itens
            const produtosLocked = [];
            const faltantes = [];
            for (const it of itensRes.rows) {
                const prRes = await client.query(
                    'SELECT id, nome, COALESCE(estoque_atual, 0)::int AS estoque_atual, COALESCE(cmv_estimado, 0) AS cmv_estimado FROM produto WHERE id = $1 FOR UPDATE',
                    [it.produto_id]
                );
                const prod = prRes.rows[0];
                if (prod.estoque_atual < it.quantidade) {
                    faltantes.push(`${prod.nome} (disponível ${prod.estoque_atual} un, necessário ${it.quantidade} un)`);
                } else {
                    produtosLocked.push({ prod, quantidade: it.quantidade });
                }
            }

            if (faltantes.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: `Saldo insuficiente na Câmara Fria para entregar o Pedido #${id}: ${faltantes.join('; ')}.`
                });
            }

            // Deduzir estoque físico e registrar Kardex
            const docRef = `Pedido #${id}`;
            for (const item of produtosLocked) {
                const saldoAnt = item.prod.estoque_atual;
                const saldoPost = saldoAnt - item.quantidade;
                await client.query('UPDATE produto SET estoque_atual = $1 WHERE id = $2', [saldoPost, item.prod.id]);
                await client.query(
                    `INSERT INTO movimentacao_estoque (
                        tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                        quantidade, unidade_medida, custo_unitario_momento,
                        saldo_anterior, saldo_posterior, documento_ref, observacao
                    ) VALUES ('PRODUTO_ACABADO', NULL, $1, 'SAIDA', 'VENDA_PEDIDO', $2, 'un', $3, $4, $5, $6, $7)`,
                    [
                        item.prod.id,
                        item.quantidade,
                        parseFloat(item.prod.cmv_estimado || 0),
                        saldoAnt,
                        saldoPost,
                        docRef,
                        `Saída definitiva na entrega do ${docRef}`
                    ]
                );
            }

            const pedAtualizado = await client.query(
                `UPDATE pedido
                 SET status = 'ENTREGUE',
                     estoque_baixado = TRUE,
                     data_entrega_efetiva = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING *`,
                [id]
            );

            await client.query('COMMIT');
            res.json({
                status: 'sucesso',
                mensagem: `Pedido #${id} entregue com sucesso! Câmara Fria baixada no Kardex.`,
                pedido: pedAtualizado.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 4c. FATURAR PEDIDO (Gera Contas a Receber e aplica crédito do cliente opcionalmente) — POST /api/comercial/pedidos/:id/faturar
    faturarPedido: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const {
                forma_pagamento = 'BOLETO',
                pagamento_tipo = 'A_PRAZO',
                data_vencimento = null,
                usar_credito = false,
                observacao = null
            } = req.body || {};

            const pedRes = await client.query('SELECT * FROM pedido WHERE id = $1 FOR UPDATE', [id]);
            if (pedRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado.' });
            }
            const ped = pedRes.rows[0];

            if (ped.status !== 'ENTREGUE' || ped.faturado) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Apenas pedidos com status ENTREGUE e ainda não faturados podem ser faturados.'
                });
            }

            const cliRes = await client.query(
                'SELECT id, razao_social, COALESCE(saldo_credito, 0)::numeric(10,2) AS saldo_credito FROM cliente WHERE id = $1 FOR UPDATE',
                [ped.cliente_id]
            );
            const cliente = cliRes.rows[0];
            const saldoCliente = parseFloat(cliente?.saldo_credito || 0);
            const valorPedido = parseFloat(ped.valor_total || 0);

            const creditoAplicado = (usar_credito === true && saldoCliente > 0 && valorPedido > 0)
                ? Number(Math.min(saldoCliente, valorPedido).toFixed(2))
                : 0;
            const valorCobrar = Number(Math.max(0, valorPedido - creditoAplicado).toFixed(2));

            const formasValidas = ['BOLETO', 'PIX', 'DINHEIRO', 'CARTAO'];
            const formaBruta = String(forma_pagamento || 'BOLETO').trim().toUpperCase();
            const formaPgto = formasValidas.includes(formaBruta) ? formaBruta : 'BOLETO';
            const pgtoTipo = String(pagamento_tipo || 'A_PRAZO').trim().toUpperCase() === 'A_VISTA' ? 'A_VISTA' : 'A_PRAZO';

            const vencLimpo = data_vencimento && String(data_vencimento).trim() ? String(data_vencimento).trim() : null;
            if (valorCobrar > 0 && pgtoTipo === 'A_PRAZO' && !vencLimpo) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Informe a data de vencimento para faturamento a prazo.' });
            }

            if (creditoAplicado > 0) {
                const novoSaldo = Number((saldoCliente - creditoAplicado).toFixed(2));
                await client.query('UPDATE cliente SET saldo_credito = $1 WHERE id = $2', [novoSaldo, ped.cliente_id]);
                await client.query(
                    `INSERT INTO credito_cliente_mov (
                        cliente_id, pedido_id, ocorrencia_id, tipo, valor, saldo_anterior, saldo_posterior, observacao
                    ) VALUES ($1, $2, NULL, 'USO', $3, $4, $5, $6)`,
                    [
                        ped.cliente_id,
                        ped.id,
                        creditoAplicado,
                        saldoCliente,
                        novoSaldo,
                        `Crédito utilizado no faturamento do Pedido #${ped.id}`
                    ]
                );
            }

            let contaReceber = null;
            let statusFinalPedido = 'ENTREGUE';

            if (valorCobrar === 0) {
                statusFinalPedido = 'CONCLUIDO';
            } else {
                const isAVista = pgtoTipo === 'A_VISTA';
                const descricaoConta = (`Pedido #${ped.id}${cliente?.razao_social ? ' - ' + cliente.razao_social : ''}`).slice(0, 200);
                const docRef = formaPgto === 'BOLETO' ? `Boleto Pedido #${ped.id}` : `Pedido #${ped.id}`;

                const crRes = await client.query(
                    `INSERT INTO conta_receber (
                        cliente_id, pedido_id, descricao, valor, credito_utilizado,
                        data_emissao, data_vencimento, data_recebimento,
                        status, forma_pagamento, documento_ref, observacao
                    ) VALUES (
                        $1, $2, $3, $4, $5,
                        CURRENT_DATE,
                        CASE WHEN $6 THEN CURRENT_DATE ELSE $7::date END,
                        CASE WHEN $6 THEN CURRENT_DATE ELSE NULL END,
                        CASE WHEN $6 THEN 'RECEBIDO' ELSE 'PENDENTE' END,
                        $8, $9, $10
                    ) RETURNING *`,
                    [
                        ped.cliente_id,
                        ped.id,
                        descricaoConta,
                        valorCobrar,
                        creditoAplicado,
                        isAVista,
                        vencLimpo,
                        formaPgto,
                        docRef,
                        observacao ? String(observacao).trim() : null
                    ]
                );
                contaReceber = crRes.rows[0];
                if (isAVista) {
                    statusFinalPedido = 'CONCLUIDO';
                }
            }

            const pedAtualizado = await client.query(
                `UPDATE pedido
                 SET faturado = TRUE,
                     status = $1
                 WHERE id = $2
                 RETURNING *`,
                [statusFinalPedido, ped.id]
            );

            await client.query('COMMIT');

            res.json({
                status: 'sucesso',
                mensagem: statusFinalPedido === 'CONCLUIDO'
                    ? `Pedido #${ped.id} faturado e concluído com sucesso!`
                    : `Pedido #${ped.id} faturado! Título gerado em Contas a Receber.`,
                pedido: pedAtualizado.rows[0],
                conta_receber: contaReceber,
                credito_utilizado: creditoAplicado,
                valor_cobrado: valorCobrar
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 4d. CANCELAR PEDIDO (Antes da entrega) — POST /api/comercial/pedidos/:id/cancelar
    cancelarPedido: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;

            const pedRes = await client.query('SELECT * FROM pedido WHERE id = $1 FOR UPDATE', [id]);
            if (pedRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado.' });
            }
            const ped = pedRes.rows[0];

            if (ped.status !== 'ABERTO' || ped.estoque_baixado) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Apenas pedidos em aberto (antes da entrega) podem ser cancelados. Para pedidos entregues, use Ocorrência / Devolução.'
                });
            }

            await limparOPsNaoConcluidasDoPedido(client, ped.id);

            await client.query(
                `UPDATE conta_receber SET status = 'CANCELADO' WHERE pedido_id = $1 AND status = 'PENDENTE'`,
                [ped.id]
            );

            const pedAtualizado = await client.query(
                `UPDATE pedido SET status = 'CANCELADO' WHERE id = $1 RETURNING *`,
                [ped.id]
            );

            await client.query('COMMIT');
            res.json({
                status: 'sucesso',
                mensagem: `Pedido #${ped.id} cancelado e OPs não concluídas removidas da fila.`,
                pedido: pedAtualizado.rows[0]
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 4e. REGISTRAR OCORRÊNCIA / DEVOLUÇÃO PÓS-ENTREGA — POST /api/comercial/pedidos/:id/ocorrencia
    registrarOcorrencia: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const {
                produto_id,
                quantidade,
                condicao_produto,
                acao_financeira,
                observacao = null
            } = req.body || {};

            const pedRes = await client.query('SELECT * FROM pedido WHERE id = $1 FOR UPDATE', [id]);
            if (pedRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Pedido não encontrado.' });
            }
            const ped = pedRes.rows[0];

            if (!ped.estoque_baixado || !['ENTREGUE', 'CONCLUIDO'].includes(ped.status)) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Ocorrências só podem ser registradas após a entrega do pedido.'
                });
            }

            const prodIdNum = parseInt(produto_id, 10);
            const qtdNum = parseInt(quantidade, 10);
            const cond = String(condicao_produto || '').trim().toUpperCase();
            const acaoSolicitada = String(acao_financeira || '').trim().toUpperCase();

            if (!prodIdNum || isNaN(qtdNum) || qtdNum <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Informe um produto e quantidade válida maior que zero.' });
            }
            if (!['BOM', 'AVARIADO'].includes(cond)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Condição do produto deve ser BOM ou AVARIADO.' });
            }
            if (!['ABATER_VALOR', 'GERAR_CREDITO', 'REPOR_PRODUTO'].includes(acaoSolicitada)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Ação financeira deve ser ABATER_VALOR, GERAR_CREDITO ou REPOR_PRODUTO.' });
            }

            const itemRes = await client.query(
                `SELECT ip.*, pr.nome AS produto_nome, pr.categoria, pr.categoria_producao, pr.embalagem_id
                 FROM item_pedido ip
                 JOIN produto pr ON pr.id = ip.produto_id
                 WHERE ip.pedido_id = $1 AND ip.produto_id = $2
                 FOR UPDATE OF ip`,
                [ped.id, prodIdNum]
            );
            if (itemRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Item não pertence a este pedido.' });
            }
            const item = itemRes.rows[0];
            const saldoItemDisponivel = parseInt(item.quantidade, 10) - parseInt(item.quantidade_avariada || 0, 10);
            if (qtdNum > saldoItemDisponivel) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: `Quantidade informada (${qtdNum}) excede o saldo disponível do item no pedido (${saldoItemDisponivel} un).`
                });
            }

            // Movimento físico na Câmara Fria se voltou BOM
            if (cond === 'BOM') {
                const prLock = await client.query(
                    'SELECT COALESCE(estoque_atual, 0)::int AS estoque_atual, COALESCE(cmv_estimado, 0) AS cmv_estimado FROM produto WHERE id = $1 FOR UPDATE',
                    [prodIdNum]
                );
                const saldoAnt = prLock.rows[0].estoque_atual;
                const saldoPost = saldoAnt + qtdNum;
                await client.query('UPDATE produto SET estoque_atual = $1 WHERE id = $2', [saldoPost, prodIdNum]);
                await client.query(
                    `INSERT INTO movimentacao_estoque (
                        tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                        quantidade, unidade_medida, custo_unitario_momento,
                        saldo_anterior, saldo_posterior, documento_ref, observacao
                    ) VALUES ('PRODUTO_ACABADO', NULL, $1, 'ENTRADA', 'DEVOLUCAO_VENDA', $2, 'un', $3, $4, $5, $6, $7)`,
                    [
                        prodIdNum,
                        qtdNum,
                        parseFloat(prLock.rows[0].cmv_estimado || 0),
                        saldoAnt,
                        saldoPost,
                        `Pedido #${ped.id}`,
                        observacao || `Retorno de mercadoria boa na entrega do Pedido #${ped.id}`
                    ]
                );
            }

            const valorOcorrencia = Number((qtdNum * parseFloat(item.preco_unitario || 0)).toFixed(2));
            let acaoEfetiva = acaoSolicitada;
            let valorAbatido = 0;
            let opReposicaoId = null;
            let saldoCreditoCliente = null;

            if (acaoSolicitada === 'REPOR_PRODUTO') {
                const opRep = await criarOPParaPedido(client, {
                    pedidoId: ped.id,
                    clienteId: ped.cliente_id,
                    produto: {
                        id: prodIdNum,
                        nome: item.produto_nome,
                        categoria: item.categoria,
                        categoria_producao: item.categoria_producao,
                        embalagem_id: item.embalagem_id
                    },
                    quantidadeFaltante: qtdNum,
                    dataEntrega: ped.data_entrega
                });
                opReposicaoId = opRep.op_id;
            } else {
                await client.query(
                    `UPDATE item_pedido
                     SET quantidade_avariada = COALESCE(quantidade_avariada, 0) + $1
                     WHERE pedido_id = $2 AND produto_id = $3`,
                    [qtdNum, ped.id, prodIdNum]
                );
                valorAbatido = valorOcorrencia;

                if (!ped.faturado) {
                    acaoEfetiva = 'ABATER_VALOR';
                    const novoValorPedido = Number(Math.max(0, parseFloat(ped.valor_total || 0) - valorOcorrencia).toFixed(2));
                    const restRes = await client.query(
                        'SELECT COALESCE(SUM(quantidade - COALESCE(quantidade_avariada, 0)), 0)::int AS rest FROM item_pedido WHERE pedido_id = $1',
                        [ped.id]
                    );
                    const novoStatus = (restRes.rows[0].rest === 0 && novoValorPedido === 0) ? 'DEVOLVIDO' : ped.status;
                    await client.query(
                        'UPDATE pedido SET valor_total = $1, status = $2 WHERE id = $3',
                        [novoValorPedido, novoStatus, ped.id]
                    );
                } else {
                    const crRes = await client.query(
                        `SELECT * FROM conta_receber
                         WHERE pedido_id = $1 AND status <> 'CANCELADO'
                         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
                        [ped.id]
                    );
                    const cr = crRes.rows[0] || null;

                    // Boleto emitido ou título já RECEBIDO (ou quitado com crédito) -> mantém cheio e gera Crédito ao Cliente
                    const forcarCredito = !cr || cr.forma_pagamento === 'BOLETO' || cr.status === 'RECEBIDO';
                    acaoEfetiva = forcarCredito ? 'GERAR_CREDITO' : acaoSolicitada;

                    if (acaoEfetiva === 'ABATER_VALOR' && cr) {
                        const novoValorTitulo = Number(Math.max(0, parseFloat(cr.valor || 0) - valorOcorrencia).toFixed(2));
                        const novoValorPedido = Number(Math.max(0, parseFloat(ped.valor_total || 0) - valorOcorrencia).toFixed(2));
                        if (novoValorTitulo === 0) {
                            await client.query(
                                `UPDATE conta_receber SET valor = 0, status = 'CANCELADO' WHERE id = $1`,
                                [cr.id]
                            );
                        } else {
                            await client.query(
                                `UPDATE conta_receber SET valor = $1 WHERE id = $2`,
                                [novoValorTitulo, cr.id]
                            );
                        }
                        const novoStatusPed = novoValorPedido === 0 ? 'DEVOLVIDO' : ped.status;
                        await client.query(
                            'UPDATE pedido SET valor_total = $1, status = $2 WHERE id = $3',
                            [novoValorPedido, novoStatusPed, ped.id]
                        );
                    }
                }
            }

            const ocRes = await client.query(
                `INSERT INTO ocorrencia_entrega (
                    pedido_id, produto_id, quantidade, condicao_produto, acao_financeira,
                    valor_abatido, op_reposicao_id, observacao
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [
                    ped.id,
                    prodIdNum,
                    qtdNum,
                    cond,
                    acaoEfetiva,
                    valorAbatido,
                    opReposicaoId,
                    observacao ? String(observacao).trim() : null
                ]
            );
            const ocorrencia = ocRes.rows[0];

            if (acaoEfetiva === 'GERAR_CREDITO' && valorOcorrencia > 0) {
                const cliLock = await client.query(
                    'SELECT COALESCE(saldo_credito, 0)::numeric(10,2) AS saldo_credito FROM cliente WHERE id = $1 FOR UPDATE',
                    [ped.cliente_id]
                );
                const saldoAntCli = parseFloat(cliLock.rows[0]?.saldo_credito || 0);
                const saldoPostCli = Number((saldoAntCli + valorOcorrencia).toFixed(2));
                saldoCreditoCliente = saldoPostCli;

                await client.query('UPDATE cliente SET saldo_credito = $1 WHERE id = $2', [saldoPostCli, ped.cliente_id]);
                await client.query(
                    `INSERT INTO credito_cliente_mov (
                        cliente_id, pedido_id, ocorrencia_id, tipo, valor, saldo_anterior, saldo_posterior, observacao
                     ) VALUES ($1, $2, $3, 'CREDITO', $4, $5, $6, $7)`,
                    [
                        ped.cliente_id,
                        ped.id,
                        ocorrencia.id,
                        valorOcorrencia,
                        saldoAntCli,
                        saldoPostCli,
                        observacao || `Crédito por ocorrência na entrega do Pedido #${ped.id}`
                    ]
                );
            }

            await client.query('COMMIT');

            res.status(201).json({
                status: 'sucesso',
                mensagem: acaoEfetiva === 'GERAR_CREDITO'
                    ? `Ocorrência registrada! Título mantido cheio e R$ ${valorOcorrencia.toFixed(2)} creditado para o cliente.`
                    : acaoEfetiva === 'REPOR_PRODUTO'
                        ? `Ocorrência registrada! OP #${opReposicaoId} de reposição criada na fila.`
                        : `Ocorrência registrada e R$ ${valorAbatido.toFixed(2)} abatido.`,
                ocorrencia,
                acao_efetiva: acaoEfetiva,
                op_reposicao_id: opReposicaoId,
                saldo_credito_cliente: saldoCreditoCliente
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // =========================================================================
    // 5. MÓDULO DE ORÇAMENTOS COMERCIAIS (COTAÇÕES B2B)
    // =========================================================================

    listarOrcamentos: async (req, res) => {
        try {
            const orcamentos = await pool.query(`
                SELECT
                    o.id,
                    o.cliente_id,
                    o.data_orcamento,
                    o.data_validade,
                    o.status,
                    o.valor_total,
                    o.observacao,
                    o.pedido_id,
                    o.criado_em,
                    c.razao_social,
                    c.cnpj,
                    c.telefone,
                    (o.status = 'PENDENTE' AND o.data_validade < CURRENT_DATE) AS vencido,
                    (SELECT COUNT(*)::int FROM item_orcamento io WHERE io.orcamento_id = o.id) AS total_itens,
                    (SELECT COALESCE(SUM(io.quantidade), 0)::int FROM item_orcamento io WHERE io.orcamento_id = o.id) AS total_unidades,
                    COALESCE((
                        SELECT json_agg(
                            json_build_object(
                                'produto_id', io.produto_id,
                                'produto_nome', pr.nome,
                                'quantidade', io.quantidade,
                                'preco_unitario', io.preco_unitario
                            ) ORDER BY pr.nome
                        )
                        FROM item_orcamento io
                        JOIN produto pr ON pr.id = io.produto_id
                        WHERE io.orcamento_id = o.id
                    ), '[]'::json) AS itens
                FROM orcamento o
                JOIN cliente c ON c.id = o.cliente_id
                ORDER BY o.id DESC
            `);
            res.json(orcamentos.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    obterOrcamento: async (req, res) => {
        try {
            const { id } = req.params;
            const orcRes = await pool.query(
                `SELECT o.*, c.razao_social, c.cnpj, c.telefone, c.endereco
                 FROM orcamento o
                 JOIN cliente c ON c.id = o.cliente_id
                 WHERE o.id = $1`,
                [id]
            );
            if (orcRes.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Orçamento não encontrado.' });
            }

            const itensRes = await pool.query(
                `SELECT io.produto_id, pr.nome AS produto_nome, io.quantidade, io.preco_unitario
                 FROM item_orcamento io
                 JOIN produto pr ON pr.id = io.produto_id
                 WHERE io.orcamento_id = $1
                 ORDER BY pr.nome ASC`,
                [id]
            );

            res.json({
                ...orcRes.rows[0],
                itens: itensRes.rows
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    criarOrcamento: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { cliente_id, data_validade, observacao, itens } = req.body;

            const clienteIdNum = parseInt(cliente_id, 10);
            if (!clienteIdNum || isNaN(clienteIdNum)) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Selecione um cliente válido.' });
            }
            if (!data_validade) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Informe a data de validade da proposta.' });
            }

            const itensConsolidados = consolidarItensPorProduto(itens || []);
            if (!itensConsolidados.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Adicione pelo menos um item válido ao orçamento.' });
            }

            let valorTotal = 0;
            for (const item of itensConsolidados) {
                valorTotal += item.quantidade * item.preco_unitario;
            }

            const obsLimpa = observacao && String(observacao).trim() ? String(observacao).trim() : null;

            const orcInsert = await client.query(
                `INSERT INTO orcamento (cliente_id, data_validade, status, valor_total, observacao)
                 VALUES ($1, $2, 'PENDENTE', $3, $4)
                 RETURNING *`,
                [clienteIdNum, data_validade, valorTotal, obsLimpa]
            );
            const novoOrc = orcInsert.rows[0];

            for (const item of itensConsolidados) {
                await client.query(
                    `INSERT INTO item_orcamento (orcamento_id, produto_id, quantidade, preco_unitario)
                     VALUES ($1, $2, $3, $4)`,
                    [novoOrc.id, item.produto_id, item.quantidade, item.preco_unitario]
                );
            }

            await client.query('COMMIT');

            res.status(201).json({
                status: 'sucesso',
                mensagem: `Orçamento #ORC-${novoOrc.id} criado com sucesso (sem reserva de estoque ou geração de OP).`,
                orcamento_id: novoOrc.id,
                valor_total: parseFloat(novoOrc.valor_total),
                orcamento: novoOrc
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    aprovarOrcamento: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const { data_entrega, tipo_pedido = 'ENTREGA', observacao = null } = req.body || {};

            if (!data_entrega) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Informe a data de entrega esperada para aprovar o orçamento.'
                });
            }

            const orcRes = await client.query(
                'SELECT * FROM orcamento WHERE id = $1 FOR UPDATE',
                [id]
            );
            if (orcRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Orçamento não encontrado.' });
            }

            const orcamento = orcRes.rows[0];
            if (orcamento.status !== 'PENDENTE') {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: `Este orçamento já está com status "${orcamento.status}" e não pode ser aprovado novamente.`
                });
            }

            const itensOrcRes = await client.query(
                'SELECT produto_id, quantidade, preco_unitario FROM item_orcamento WHERE orcamento_id = $1',
                [id]
            );
            if (itensOrcRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Orçamento não possui itens para converter em pedido.' });
            }

            const resultadoPedido = await processarLancamentoPedidoTransacional(client, {
                cliente_id: orcamento.cliente_id,
                data_entrega,
                itens: itensOrcRes.rows,
                tipo_pedido,
                observacao: observacao || orcamento.observacao || `Aprovado a partir do Orçamento #ORC-${id}`
            });

            const orcAtualizado = await client.query(
                `UPDATE orcamento
                 SET status = 'APROVADO',
                     pedido_id = $1
                 WHERE id = $2
                 RETURNING *`,
                [resultadoPedido.pedidoId, id]
            );

            await client.query('COMMIT');

            let mensagem = `Orçamento #ORC-${id} aprovado e convertido no Pedido #${resultadoPedido.pedidoId}!`;
            if (resultadoPedido.opsGeradas.length > 0) {
                mensagem += ` ${resultadoPedido.opsGeradas.length} OP(s) gerada(s) na fila de produção.`;
            }

            res.json({
                status: 'sucesso',
                mensagem,
                orcamento_id: parseInt(id, 10),
                pedido_id: resultadoPedido.pedidoId,
                orcamento: orcAtualizado.rows[0],
                ops_geradas: resultadoPedido.opsGeradas,
                avisos: resultadoPedido.avisos
            });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(error.statusCode || 500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    recusarOrcamento: async (req, res) => {
        try {
            const { id } = req.params;
            const check = await pool.query('SELECT * FROM orcamento WHERE id = $1', [id]);
            if (check.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Orçamento não encontrado.' });
            }
            if (check.rows[0].status === 'APROVADO') {
                return res.status(400).json({
                    status: 'erro',
                    erro: 'Não é possível recusar um orçamento já aprovado e convertido em pedido.'
                });
            }

            const updated = await pool.query(
                `UPDATE orcamento SET status = 'RECUSADO' WHERE id = $1 RETURNING *`,
                [id]
            );

            res.json({
                status: 'sucesso',
                mensagem: `Orçamento #ORC-${id} marcado como RECUSADO.`,
                orcamento: updated.rows[0]
            });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    }
};

module.exports = comercialController;
