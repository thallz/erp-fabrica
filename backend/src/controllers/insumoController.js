const pool = require('../config/db');
const { recalcularTodasReceitas } = require('../utils/recalcularCustos');

const insumoController = {
    // 1. Rota para CRIAR um novo insumo
    criar: async (req, res) => {
        try {
            const { nome, categoria, unidade_medida, custo_unitario, estoque_atual, preco_pago, peso_embalagem, tipo_medida } = req.body;
            
            const precoPagoNum = parseFloat(preco_pago || 0);
            const pesoEmbalagemNum = parseFloat(peso_embalagem || 1000);
            const tipoMedidaStr = tipo_medida || 'Peso';

            // Cálculo do custo unitário (custo por kg ou por unidade)
            let custoCalc = parseFloat(custo_unitario || 0);
            if (precoPagoNum > 0 && pesoEmbalagemNum > 0) {
                if (tipoMedidaStr === 'Peso') {
                    custoCalc = (precoPagoNum / pesoEmbalagemNum) * 1000.0;
                } else {
                    custoCalc = precoPagoNum / pesoEmbalagemNum;
                }
            }

            const novoInsumo = await pool.query(
                `INSERT INTO insumo (nome, categoria, unidade_medida, custo_unitario, estoque_atual, preco_pago, peso_embalagem, tipo_medida) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [
                    nome, 
                    categoria || 'Outros', 
                    unidade_medida || 'kg', 
                    custoCalc, 
                    estoque_atual ?? 0,
                    precoPagoNum,
                    pesoEmbalagemNum,
                    tipoMedidaStr
                ]
            );
            await recalcularTodasReceitas();
            res.status(201).json(novoInsumo.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
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
        try {
            const { id } = req.params;
            const { nome, categoria, unidade_medida, custo_unitario, estoque_atual, preco_pago, peso_embalagem, tipo_medida } = req.body;
            
            const precoPagoNum = parseFloat(preco_pago || 0);
            const pesoEmbalagemNum = parseFloat(peso_embalagem || 1000);
            const tipoMedidaStr = tipo_medida || 'Peso';

            let custoCalc = parseFloat(custo_unitario || 0);
            if (precoPagoNum > 0 && pesoEmbalagemNum > 0) {
                if (tipoMedidaStr === 'Peso') {
                    custoCalc = (precoPagoNum / pesoEmbalagemNum) * 1000.0;
                } else {
                    custoCalc = precoPagoNum / pesoEmbalagemNum;
                }
            }

            const result = await pool.query(
                `UPDATE insumo 
                 SET nome = $1, categoria = $2, unidade_medida = $3, custo_unitario = $4, estoque_atual = $5, preco_pago = $6, peso_embalagem = $7, tipo_medida = $8 
                 WHERE id = $9 RETURNING *`,
                [
                    nome, 
                    categoria || 'Outros', 
                    unidade_medida || 'kg', 
                    custoCalc, 
                    estoque_atual ?? 0, 
                    precoPagoNum, 
                    pesoEmbalagemNum, 
                    tipoMedidaStr, 
                    id
                ]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Insumo não encontrado' });
            }
            await recalcularTodasReceitas();
            res.json(result.rows[0]);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
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
    }
};

module.exports = insumoController;