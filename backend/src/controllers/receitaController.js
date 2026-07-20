const pool = require('../config/db');
const { recalcularTodasReceitas } = require('../utils/recalcularCustos');

function mapReceitaRow(row, itens) {
    return {
        id: row.id,
        nome: row.nome,
        categoria: row.categoria,
        custo: parseFloat(row.custo_total || 0),
        pesoTotal: parseFloat(row.peso_total || 0),
        custoPorKg: parseFloat(row.custo_por_kg || 0),
        itens: itens.map(i => ({
            nome: i.nome,
            idOrigem: i.origem_id,
            tipoOrigem: i.tipo_origem,
            g: parseFloat(i.quantidade_gramas || 0),
            custoUnitario: parseFloat(i.custo_unitario || 0),
            custo: parseFloat(i.custo || 0)
        }))
    };
}

async function buscarItens(client, receitaId) {
    const result = await client.query(
        'SELECT * FROM receita_item WHERE receita_id = $1 ORDER BY id ASC',
        [receitaId]
    );
    return result.rows;
}

async function gravarItens(client, receitaId, itens) {
    await client.query('DELETE FROM receita_item WHERE receita_id = $1', [receitaId]);
    for (const item of itens) {
        await client.query(
            `INSERT INTO receita_item
            (receita_id, tipo_origem, origem_id, nome, quantidade_gramas, custo_unitario, custo)
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                receitaId,
                item.tipoOrigem || item.tipo_origem,
                item.idOrigem || item.origem_id,
                item.nome,
                item.g || item.quantidade_gramas || 0,
                item.custoUnitario || item.custo_unitario || 0,
                item.custo || 0
            ]
        );
    }
}

const receitaController = {
    listar: async (req, res) => {
        try {
            await recalcularTodasReceitas();
            const receitas = await pool.query('SELECT * FROM receita ORDER BY nome ASC');
            const resultado = [];
            for (const row of receitas.rows) {
                const itens = await buscarItens(pool, row.id);
                resultado.push(mapReceitaRow(row, itens));
            }
            res.json(resultado);
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    criar: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { nome, categoria, itens } = req.body;
            if (!nome || !itens || !itens.length) {
                return res.status(400).json({ status: 'erro', erro: 'Nome e itens são obrigatórios' });
            }

            const result = await client.query(
                `INSERT INTO receita (nome, categoria, custo_total, peso_total, custo_por_kg)
                 VALUES ($1, $2, 0, 0, 0) RETURNING *`,
                [nome, categoria || 'Geral']
            );
            const receitaId = result.rows[0].id;
            await gravarItens(client, receitaId, itens);

            await client.query('COMMIT');

            // Recalcular todas as receitas em cascata com transação fechada
            await recalcularTodasReceitas();

            const recResult = await pool.query('SELECT * FROM receita WHERE id = $1', [receitaId]);
            const itensSalvos = await buscarItens(pool, receitaId);
            res.status(201).json(mapReceitaRow(recResult.rows[0], itensSalvos));
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    atualizar: async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { id } = req.params;
            const { nome, categoria, itens } = req.body;
            if (!nome || !itens || !itens.length) {
                return res.status(400).json({ status: 'erro', erro: 'Nome e itens são obrigatórios' });
            }

            const result = await client.query(
                `UPDATE receita SET nome = $1, categoria = $2 WHERE id = $3 RETURNING *`,
                [nome, categoria || 'Geral', id]
            );
            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ status: 'erro', erro: 'Receita não encontrada' });
            }

            await gravarItens(client, id, itens);
            await client.query('COMMIT');

            // Recalcular todas as receitas em cascata
            await recalcularTodasReceitas();

            const recResult = await pool.query('SELECT * FROM receita WHERE id = $1', [id]);
            const itensSalvos = await buscarItens(pool, id);
            res.json(mapReceitaRow(recResult.rows[0], itensSalvos));
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    },

    excluir: async (req, res) => {
        try {
            const { id } = req.params;
            const result = await pool.query('DELETE FROM receita WHERE id = $1 RETURNING id', [id]);
            if (result.rows.length === 0) {
                return res.status(404).json({ status: 'erro', erro: 'Receita não encontrada' });
            }
            await recalcularTodasReceitas();
            res.json({ status: 'sucesso', id: result.rows[0].id });
        } catch (error) {
            res.status(500).json({ status: 'erro', erro: error.message });
        }
    },

    importar: async (req, res) => {
        const client = await pool.connect();
        try {
            const { receitas, mapa_insumos } = req.body;
            if (!Array.isArray(receitas)) {
                return res.status(400).json({ status: 'erro', erro: 'Envie um array receitas' });
            }

            const mapaInsumo = mapa_insumos || {};
            const mapaReceita = {};
            const pendentes = [...receitas];
            let importadas = 0;

            await client.query('BEGIN');

            const resolverOrigem = (item) => {
                const chave = String(item.idOrigem ?? item.origem_id);
                if (item.tipoOrigem === 'materia' || item.tipo_origem === 'materia') {
                    return Number(mapaInsumo[chave] ?? item.idOrigem ?? item.origem_id);
                }
                return Number(mapaReceita[chave] ?? item.idOrigem ?? item.origem_id);
            };

            const podeImportar = (rec) => (rec.itens || []).every((item) => {
                const tipo = item.tipoOrigem || item.tipo_origem;
                const chave = String(item.idOrigem ?? item.origem_id);
                if (tipo === 'materia') {
                    if (mapaInsumo[chave] != null) return true;
                    if (Object.keys(mapaInsumo).length === 0) return Number(item.idOrigem) > 0;
                    return false;
                }
                return mapaReceita[chave] != null;
            });

            for (let rodada = 0; rodada < 20 && pendentes.length; rodada++) {
                let progresso = false;
                for (let i = pendentes.length - 1; i >= 0; i--) {
                    const rec = pendentes[i];
                    if (!podeImportar(rec)) continue;

                    const itens = (rec.itens || []).map((item) => ({
                        ...item,
                        tipoOrigem: item.tipoOrigem || item.tipo_origem,
                        idOrigem: resolverOrigem(item),
                        g: item.g ?? item.quantidade_gramas
                    }));

                    const result = await client.query(
                        `INSERT INTO receita (nome, categoria, custo_total, peso_total, custo_por_kg)
                         VALUES ($1, $2, 0, 0, 0) RETURNING id`,
                        [rec.nome, rec.categoria || 'Geral']
                    );
                    const novoId = result.rows[0].id;
                    await gravarItens(client, novoId, itens);

                    if (rec.id != null) mapaReceita[String(rec.id)] = novoId;
                    pendentes.splice(i, 1);
                    importadas++;
                    progresso = true;
                }
                if (!progresso) break;
            }

            if (pendentes.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    status: 'erro',
                    erro: `${pendentes.length} receita(s) com dependências não resolvidas`,
                    importadas: 0,
                    pendentes: pendentes.map((r) => r.nome)
                });
            }

            await client.query('COMMIT');
            await recalcularTodasReceitas();
            res.json({ status: 'sucesso', importadas, mapa_receitas: mapaReceita });
        } catch (error) {
            await client.query('ROLLBACK');
            res.status(500).json({ status: 'erro', erro: error.message });
        } finally {
            client.release();
        }
    }
};

module.exports = receitaController;
