const pool = require('../config/db');

/**
 * Recalcula o custo total e custo_por_kg de TODAS as receitas e seus itens no banco de dados,
 * considerando os preços atualizados dos insumos no Almoxarifado e o efeito em cascata das sub-receitas.
 */
async function recalcularTodasReceitas(dbClient = null) {
  const client = dbClient || await pool.connect();
  const ownsClient = !dbClient;

  try {
    // 1. Carregar todos os insumos (mapa de id -> custo_unitario)
    const insumosRes = await client.query('SELECT id, custo_unitario FROM insumo');
    const insumoMap = {};
    insumosRes.rows.forEach(i => {
      insumoMap[i.id] = parseFloat(i.custo_unitario || 0);
    });

    // 2. Carregar todas as receitas
    const receitasRes = await client.query('SELECT id, nome FROM receita ORDER BY id ASC');
    const receitas = receitasRes.rows;

    // Mapa de receitaId -> { custoPorKg, custoTotal, pesoTotal }
    const receitaMap = {};

    // 3. Fazer múltiplas rodadas (multi-pass) para resolver dependências em cascata (sub-receitas)
    for (let pass = 0; pass < 10; pass++) {
      let mudou = false;

      for (const rec of receitas) {
        const itensRes = await client.query(
          'SELECT * FROM receita_item WHERE receita_id = $1 ORDER BY id ASC',
          [rec.id]
        );

        let custoTotalBatelada = 0;
        let pesoTotalBatelada = 0;

        for (const item of itensRes.rows) {
          const g = parseFloat(item.quantidade_gramas || 0);
          pesoTotalBatelada += g;

          let custoUnitarioKg = 0;

          if (item.tipo_origem === 'materia') {
            custoUnitarioKg = insumoMap[item.origem_id] || 0;
          } else if (item.tipo_origem === 'receita') {
            custoUnitarioKg = receitaMap[item.origem_id] ? receitaMap[item.origem_id].custoPorKg : 0;
          }

          // Custo por grama = custoUnitarioKg / 1000
          const custoItem = g * (custoUnitarioKg / 1000.0);
          custoTotalBatelada += custoItem;

          // Atualizar custo e custo_unitario do item no BD se mudou
          await client.query(
            'UPDATE receita_item SET custo_unitario = $1, custo = $2 WHERE id = $3',
            [custoUnitarioKg, custoItem, item.id]
          );
        }

        const custoPorKg = pesoTotalBatelada > 0 ? (custoTotalBatelada / pesoTotalBatelada) * 1000.0 : 0;

        const prev = receitaMap[rec.id];
        if (!prev || Math.abs(prev.custoPorKg - custoPorKg) > 0.0001) {
          mudou = true;
          receitaMap[rec.id] = { custoPorKg, custoTotal: custoTotalBatelada, pesoTotal: pesoTotalBatelada };
        }

        // Atualizar tabela receita
        await client.query(
          'UPDATE receita SET custo_total = $1, peso_total = $2, custo_por_kg = $3 WHERE id = $4',
          [custoTotalBatelada, pesoTotalBatelada, custoPorKg, rec.id]
        );
      }

      if (!mudou) break;
    }
  } catch (err) {
    console.error('Erro ao recalcular receitas em cascata:', err);
  } finally {
    if (ownsClient) client.release();
  }
}

module.exports = { recalcularTodasReceitas };
