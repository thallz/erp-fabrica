const pool = require('../config/db');
const { recalcularTodasReceitas } = require('../utils/recalcularCustos');

const insumoController = {
    // 1. Rota para CRIAR um novo insumo
    criar: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { nome, categoria, unidade_medida, custo_unitario, estoque_atual, preco_pago, peso_embalagem, tipo_medida } = req.body;
            
            const precoPagoNum = parseFloat(preco_pago || 0);
            const pesoEmbalagemNum = parseFloat(peso_embalagem || 1000);
            const tipoMedidaStr = tipo_medida || 'Peso';
            const unidadeStr = unidade_medida || (tipoMedidaStr === 'Unidade' ? 'un' : 'kg');
            const estoqueInicial = parseFloat(estoque_atual ?? 0) || 0;

            // Cálculo do custo unitário (custo por kg ou por unidade)
            let custoCalc = parseFloat(custo_unitario || 0);
            if (precoPagoNum > 0 && pesoEmbalagemNum > 0) {
                if (tipoMedidaStr === 'Peso') {
                    custoCalc = (precoPagoNum / pesoEmbalagemNum) * 1000.0;
                } else {
                    custoCalc = precoPagoNum / pesoEmbalagemNum;
                }
            }

            const novoInsumo = await client.query(
                `INSERT INTO insumo (nome, categoria, unidade_medida, custo_unitario, estoque_atual, preco_pago, peso_embalagem, tipo_medida) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [
                    nome, 
                    categoria || 'Outros', 
                    unidadeStr, 
                    custoCalc, 
                    estoqueInicial,
                    precoPagoNum,
                    pesoEmbalagemNum,
                    tipoMedidaStr
                ]
            );

            const insumoCriado = novoInsumo.rows[0];

            // Registrar saldo inicial no Kardex se > 0
            if (estoqueInicial > 0) {
                await client.query(
                    `INSERT INTO movimentacao_estoque (
                        tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                        quantidade, unidade_medida, custo_unitario_momento,
                        saldo_anterior, saldo_posterior, documento_ref, observacao
                    ) VALUES ('MATERIA_PRIMA', $1, NULL, 'ENTRADA', 'SALDO_INICIAL', $2, $3, $4, 0, $5, 'CADASTRO', 'Saldo inicial informado no cadastro do insumo')`,
                    [insumoCriado.id, estoqueInicial, unidadeStr, custoCalc, estoqueInicial]
                );
            }

            await recalcularTodasReceitas(client);
            await client.query('COMMIT');
            res.status(201).json(insumoCriado);
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 2. Rota para LER (Listar) todos os insumos
    listar: async (req, res) => {
        try {
            const todosInsumos = await pool.query('SELECT * FROM insumo ORDER BY nome ASC');
            res.json(todosInsumos.rows);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 3. Atualizar insumo existente (dispara recálculo em cascata nas receitas e produtos)
    atualizar: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const { nome, categoria, unidade_medida, custo_unitario, estoque_atual, preco_pago, peso_embalagem, tipo_medida } = req.body;
            
            const antRes = await client.query('SELECT estoque_atual, unidade_medida FROM insumo WHERE id = $1 FOR UPDATE', [id]);
            if (antRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Insumo não encontrado' });
            }
            const saldoAnt = parseFloat(antRes.rows[0].estoque_atual || 0);

            const precoPagoNum = parseFloat(preco_pago || 0);
            const pesoEmbalagemNum = parseFloat(peso_embalagem || 1000);
            const tipoMedidaStr = tipo_medida || 'Peso';
            const unidadeStr = unidade_medida || (tipoMedidaStr === 'Unidade' ? 'un' : 'kg');
            const novoSaldo = estoque_atual !== undefined ? parseFloat(estoque_atual) : saldoAnt;

            let custoCalc = parseFloat(custo_unitario || 0);
            if (precoPagoNum > 0 && pesoEmbalagemNum > 0) {
                if (tipoMedidaStr === 'Peso') {
                    custoCalc = (precoPagoNum / pesoEmbalagemNum) * 1000.0;
                } else {
                    custoCalc = precoPagoNum / pesoEmbalagemNum;
                }
            }

            const result = await client.query(
                `UPDATE insumo 
                 SET nome = $1, categoria = $2, unidade_medida = $3, custo_unitario = $4, estoque_atual = $5, preco_pago = $6, peso_embalagem = $7, tipo_medida = $8 
                 WHERE id = $9 RETURNING *`,
                [
                    nome, 
                    categoria || 'Outros', 
                    unidadeStr, 
                    custoCalc, 
                    novoSaldo, 
                    precoPagoNum, 
                    pesoEmbalagemNum, 
                    tipoMedidaStr, 
                    id
                ]
            );

            // Se o saldo mudou pela edição direta do cadastro, registrar ajuste no Kardex
            if (Math.abs(novoSaldo - saldoAnt) > 0.0001) {
                await client.query(
                    `INSERT INTO movimentacao_estoque (
                        tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                        quantidade, unidade_medida, custo_unitario_momento,
                        saldo_anterior, saldo_posterior, documento_ref, observacao
                    ) VALUES ('MATERIA_PRIMA', $1, NULL, 'AJUSTE', 'EDICAO_CADASTRO', $2, $3, $4, $5, $6, 'CADASTRO', 'Ajuste de saldo via edição do cadastro de insumo')`,
                    [id, Math.abs(novoSaldo - saldoAnt), unidadeStr, custoCalc, saldoAnt, novoSaldo]
                );
            }

            await recalcularTodasReceitas(client);
            await client.query('COMMIT');
            res.json(result.rows[0]);
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    // 4. Excluir insumo
    excluir: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM insumo WHERE id = $1 RETURNING id', [id]);
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Insumo não encontrado' });
            }
            await recalcularTodasReceitas();
            res.json({ status: 'sucesso', id: result.rows[0].id });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    // 5. Entrada rápida de estoque (compatibilidade legada — também registra no Kardex)
    darEntrada: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const { quantidade } = req.body;
            const qtdNum = parseFloat(quantidade || 0);

            if (isNaN(qtdNum) || qtdNum <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ status: 'erro', erro: 'Quantidade deve ser um número maior que zero' });
            }

            const antRes = await client.query(
                'SELECT COALESCE(estoque_atual, 0) AS estoque_atual, unidade_medida, custo_unitario FROM insumo WHERE id = $1 FOR UPDATE',
                [id]
            );
            if (antRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Insumo não encontrado' });
            }

            const saldoAnt = parseFloat(antRes.rows[0].estoque_atual || 0);
            const saldoPost = saldoAnt + qtdNum;
            const unidade = antRes.rows[0].unidade_medida || 'kg';
            const custo = parseFloat(antRes.rows[0].custo_unitario || 0);

            const result = await client.query(
                `UPDATE insumo SET estoque_atual = $1 WHERE id = $2 RETURNING *`,
                [saldoPost, id]
            );

            await client.query(
                `INSERT INTO movimentacao_estoque (
                    tipo_estoque, insumo_id, produto_id, tipo_movimento, motivo,
                    quantidade, unidade_medida, custo_unitario_momento,
                    saldo_anterior, saldo_posterior, documento_ref, observacao
                ) VALUES ('MATERIA_PRIMA', $1, NULL, 'ENTRADA', 'COMPRA_FORNECEDOR', $2, $3, $4, $5, $6, NULL, 'Entrada de estoque')`,
                [id, qtdNum, unidade, custo, saldoAnt, saldoPost]
            );

            await client.query('COMMIT');
            res.json({ status: 'sucesso', mensagem: 'Estoque atualizado com sucesso!', insumo: result.rows[0] });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    }
};

module.exports = insumoController;
