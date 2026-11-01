const pool = require('../config/db');

const financeiroController = {
  // 1. RESUMO GERAL DO FLUXO DE CAIXA
  resumo: async (req, res) => {
    try {
      const vendas = await pool.query(`
        SELECT
          COALESCE(SUM(valor_total), 0) AS faturamento_total,
          COUNT(*) AS total_pedidos,
          COALESCE(SUM(CASE WHEN status = 'CRIADO' THEN valor_total ELSE 0 END), 0) AS pendente_producao,
          COALESCE(SUM(CASE WHEN status IN ('FATURADO', 'PRODUZINDO') THEN valor_total ELSE 0 END), 0) AS a_receber,
          COALESCE(SUM(CASE WHEN status = 'ENTREGUE' THEN valor_total ELSE 0 END), 0) AS recebido
        FROM pedido
      `);

      const porStatus = await pool.query(`
        SELECT status, COUNT(*)::int AS quantidade, COALESCE(SUM(valor_total), 0) AS valor
        FROM pedido
        GROUP BY status
        ORDER BY status
      `);

      const cmvMedio = await pool.query(`
        SELECT COALESCE(AVG(p.cmv_estimado), 0) AS cmv_medio_produtos
        FROM produto p
      `);

      const pagarResumo = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'PENDENTE' THEN valor ELSE 0 END), 0) AS contas_a_pagar_pendente,
          COALESCE(SUM(CASE WHEN status = 'PAGO' THEN valor ELSE 0 END), 0) AS contas_pagas_total
        FROM conta_pagar
      `);

      const receberResumo = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'PENDENTE' THEN valor ELSE 0 END), 0) AS contas_a_receber_pendente,
          COALESCE(SUM(CASE WHEN status = 'RECEBIDO' THEN valor ELSE 0 END), 0) AS contas_recebidas_total
        FROM conta_receber
      `);

      res.json({
        ...vendas.rows[0],
        ...pagarResumo.rows[0],
        ...receberResumo.rows[0],
        cmv_medio_produtos: parseFloat(cmvMedio.rows[0].cmv_medio_produtos),
        pedidos_por_status: porStatus.rows
      });
    } catch (error) {
      res.status(500).json({ status: 'erro', erro: error.message });
    }
  },

  // 2. LISTAR CONTAS A RECEBER (com filtros por status/mês + dados do cliente + KPIs)
  listarContasReceber: async (req, res) => {
    try {
      const { status, mes } = req.query;
      const params = [];
      const where = [];

      if (status) {
        const st = String(status).toUpperCase();
        if (st === 'VENCIDO') {
          where.push(`cr.status = 'PENDENTE' AND cr.data_vencimento < CURRENT_DATE`);
        } else if (['PENDENTE', 'RECEBIDO', 'CANCELADO'].includes(st)) {
          params.push(st);
          where.push(`cr.status = $${params.length}`);
        }
      }

      if (mes && /^\d{4}-\d{2}$/.test(mes)) {
        params.push(mes);
        where.push(`TO_CHAR(cr.data_vencimento, 'YYYY-MM') = $${params.length}`);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const titulosRes = await pool.query(
        `SELECT
            cr.*,
            COALESCE(c.razao_social, 'Cliente Avulso') AS razao_social,
            c.cnpj,
            c.telefone,
            p.status AS status_pedido,
            p.data_entrega,
            (cr.status = 'PENDENTE' AND cr.data_vencimento < CURRENT_DATE) AS vencido
         FROM conta_receber cr
         LEFT JOIN cliente c ON c.id = cr.cliente_id
         LEFT JOIN pedido p ON p.id = cr.pedido_id
         ${whereSql}
         ORDER BY
            CASE WHEN cr.status = 'PENDENTE' THEN 0 ELSE 1 END ASC,
            cr.data_vencimento ASC,
            cr.id DESC`,
        params
      );

      const mesRefRes = mes && /^\d{4}-\d{2}$/.test(mes)
        ? { rows: [{ mes_ref: mes }] }
        : await pool.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM') AS mes_ref`);
      const mesRef = mesRefRes.rows[0].mes_ref;

      const kpiRes = await pool.query(
        `SELECT
            COALESCE(SUM(CASE
              WHEN status = 'PENDENTE'
              THEN valor ELSE 0 END), 0) AS total_a_receber,
            COALESCE(SUM(CASE
              WHEN status = 'PENDENTE' AND data_vencimento < CURRENT_DATE
              THEN valor ELSE 0 END), 0) AS total_vencidos,
            COALESCE(SUM(CASE
              WHEN status = 'RECEBIDO' AND TO_CHAR(COALESCE(data_recebimento, data_vencimento), 'YYYY-MM') = $1
              THEN valor ELSE 0 END), 0) AS total_recebidos_mes
         FROM conta_receber`,
        [mesRef]
      );

      const k = kpiRes.rows[0];

      res.json({
        status: 'sucesso',
        mes_referencia: mesRef,
        kpis: {
          total_a_receber: parseFloat(k.total_a_receber || 0),
          total_vencidos: parseFloat(k.total_vencidos || 0),
          total_recebidos_mes: parseFloat(k.total_recebidos_mes || 0)
        },
        dados: titulosRes.rows
      });
    } catch (error) {
      res.status(500).json({ status: 'erro', erro: error.message });
    }
  },

  // 2b. CRIAR CONTA A RECEBER AVULSA (Opcional)
  criarContaReceber: async (req, res) => {
    try {
      const {
        cliente_id = null,
        descricao,
        valor,
        data_vencimento,
        forma_pagamento = 'BOLETO',
        documento_ref = null,
        pagamento_tipo = 'A_PRAZO',
        observacao = null
      } = req.body;

      const descLimpa = (descricao || '').trim();
      const valorNum = parseFloat(valor);

      if (!descLimpa || isNaN(valorNum) || valorNum <= 0) {
        return res.status(400).json({
          status: 'erro',
          erro: 'Preencha uma descrição e um valor maior que zero.'
        });
      }
      if (!data_vencimento && String(pagamento_tipo).toUpperCase() !== 'A_VISTA') {
        return res.status(400).json({
          status: 'erro',
          erro: 'Informe a data de vencimento.'
        });
      }

      const isAVista = String(pagamento_tipo).toUpperCase() === 'A_VISTA';
      const cliIdNum = cliente_id ? parseInt(cliente_id, 10) : null;

      const result = await pool.query(
        `INSERT INTO conta_receber (
            cliente_id, pedido_id, descricao, valor,
            data_emissao, data_vencimento, data_recebimento,
            status, forma_pagamento, documento_ref, observacao
         ) VALUES (
            $1, NULL, $2, $3,
            CURRENT_DATE, COALESCE($4::date, CURRENT_DATE),
            CASE WHEN $5 THEN CURRENT_DATE ELSE NULL END,
            CASE WHEN $5 THEN 'RECEBIDO' ELSE 'PENDENTE' END,
            $6, $7, $8
         ) RETURNING *`,
        [
          cliIdNum,
          descLimpa,
          valorNum,
          data_vencimento || null,
          isAVista,
          String(forma_pagamento || 'BOLETO').toUpperCase(),
          documento_ref ? String(documento_ref).trim() : null,
          observacao ? String(observacao).trim() : null
        ]
      );

      res.status(201).json({
        status: 'sucesso',
        mensagem: 'Conta a receber cadastrada com sucesso!',
        conta: result.rows[0]
      });
    } catch (error) {
      res.status(500).json({ status: 'erro', erro: error.message });
    }
  },

  // 2c. CONFIRMAR RECEBIMENTO / DAR BAIXA EM CONTAS A RECEBER
  receberConta: async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { id } = req.params;
      const { forma_pagamento } = req.body || {};

      const check = await client.query('SELECT * FROM conta_receber WHERE id = $1 FOR UPDATE', [id]);
      if (check.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'erro', erro: 'Título não encontrado em Contas a Receber.' });
      }

      const atual = check.rows[0];
      if (atual.status === 'RECEBIDO') {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'erro', erro: 'Este título já consta como RECEBIDO.' });
      }
      if (atual.status === 'CANCELADO') {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'erro', erro: 'Não é possível baixar um título cancelado.' });
      }

      const formaFinal = forma_pagamento ? String(forma_pagamento).toUpperCase() : atual.forma_pagamento;
      const updated = await client.query(
        `UPDATE conta_receber
         SET status = 'RECEBIDO',
             data_recebimento = CURRENT_DATE,
             forma_pagamento = $1
         WHERE id = $2
         RETURNING *`,
        [formaFinal, id]
      );

      await client.query('COMMIT');
      res.json({
        status: 'sucesso',
        mensagem: `Título #${id} (${atual.descricao}) confirmado como RECEBIDO com sucesso!`,
        conta: updated.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(500).json({ status: 'erro', erro: error.message });
    } finally {
      client.release();
    }
  },

  // 3. LISTAR CONTAS A PAGAR (com filtros por status e mês + KPIs)
  listarContasPagar: async (req, res) => {
    try {
      const { status, mes } = req.query;
      const params = [];
      const where = [];

      if (status) {
        const st = String(status).toUpperCase();
        if (st === 'VENCIDO') {
          where.push(`cp.status = 'PENDENTE' AND cp.data_vencimento < CURRENT_DATE`);
        } else if (['PENDENTE', 'PAGO', 'CANCELADO'].includes(st)) {
          params.push(st);
          where.push(`cp.status = $${params.length}`);
        }
      }

      if (mes && /^\d{4}-\d{2}$/.test(mes)) {
        params.push(mes);
        where.push(`TO_CHAR(cp.data_vencimento, 'YYYY-MM') = $${params.length}`);
      }

      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const titulosRes = await pool.query(
        `SELECT
            cp.*,
            (cp.status = 'PENDENTE' AND cp.data_vencimento < CURRENT_DATE) AS vencido
         FROM conta_pagar cp
         ${whereSql}
         ORDER BY
            CASE WHEN cp.status = 'PENDENTE' THEN 0 ELSE 1 END ASC,
            cp.data_vencimento ASC,
            cp.id DESC`,
        params
      );

      // KPIs do mês selecionado (ou mês corrente caso nenhum filtro de mês seja enviado)
      const mesRefRes = mes && /^\d{4}-\d{2}$/.test(mes)
        ? { rows: [{ mes_ref: mes }] }
        : await pool.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM') AS mes_ref`);
      const mesRef = mesRefRes.rows[0].mes_ref;

      const kpiRes = await pool.query(
        `SELECT
            COALESCE(SUM(CASE
              WHEN status = 'PENDENTE' AND TO_CHAR(data_vencimento, 'YYYY-MM') = $1
              THEN valor ELSE 0 END), 0) AS total_a_pagar_mes,
            COALESCE(SUM(CASE
              WHEN status = 'PENDENTE'
              THEN valor ELSE 0 END), 0) AS total_pendente_geral,
            COALESCE(SUM(CASE
              WHEN status = 'PENDENTE' AND data_vencimento < CURRENT_DATE
              THEN valor ELSE 0 END), 0) AS total_vencidos,
            COALESCE(SUM(CASE
              WHEN status = 'PAGO' AND TO_CHAR(COALESCE(data_pagamento, data_vencimento), 'YYYY-MM') = $1
              THEN valor ELSE 0 END), 0) AS total_pagos_mes
         FROM conta_pagar`,
        [mesRef]
      );

      const k = kpiRes.rows[0];

      res.json({
        status: 'sucesso',
        mes_referencia: mesRef,
        kpis: {
          total_a_pagar_mes: parseFloat(k.total_a_pagar_mes || 0),
          total_pendente_geral: parseFloat(k.total_pendente_geral || 0),
          total_vencidos: parseFloat(k.total_vencidos || 0),
          total_pagos_mes: parseFloat(k.total_pagos_mes || 0)
        },
        dados: titulosRes.rows
      });
    } catch (error) {
      res.status(500).json({ status: 'erro', erro: error.message });
    }
  },

  // 4. CRIAR CONTA A PAGAR AVULSA (Energia, Água, Aluguel, Manutenção, etc.)
  criarContaPagar: async (req, res) => {
    try {
      const {
        fornecedor,
        descricao,
        valor,
        data_vencimento,
        forma_pagamento = 'BOLETO',
        documento_ref,
        pagamento_tipo = 'A_PRAZO',
        observacao
      } = req.body;

      const fornLimpo = (fornecedor || '').trim();
      const descLimpa = (descricao || '').trim();
      const valorNum = parseFloat(valor);

      if (!fornLimpo || !descLimpa || isNaN(valorNum) || valorNum <= 0) {
        return res.status(400).json({ status: 'erro', erro: 'Preencha fornecedor, descrição e um valor maior que zero.' });
      }
      if (!data_vencimento && pagamento_tipo !== 'A_VISTA') {
        return res.status(400).json({ status: 'erro', erro: 'Informe a data de vencimento.' });
      }

      const isAVista = String(pagamento_tipo).toUpperCase() === 'A_VISTA';
      const result = await pool.query(
        `INSERT INTO conta_pagar (
            fornecedor, descricao, valor, data_emissao, data_vencimento, data_pagamento,
            status, forma_pagamento, documento_ref, observacao
         ) VALUES (
            $1, $2, $3, CURRENT_DATE, COALESCE($4::date, CURRENT_DATE),
            CASE WHEN $5 THEN CURRENT_DATE ELSE NULL END,
            CASE WHEN $5 THEN 'PAGO' ELSE 'PENDENTE' END,
            $6, $7, $8
         ) RETURNING *`,
        [
          fornLimpo,
          descLimpa,
          valorNum,
          data_vencimento || null,
          isAVista,
          String(forma_pagamento || 'BOLETO').toUpperCase(),
          documento_ref ? String(documento_ref).trim() : null,
          observacao ? String(observacao).trim() : null
        ]
      );

      res.status(201).json({
        status: 'sucesso',
        mensagem: 'Conta a pagar cadastrada com sucesso!',
        conta: result.rows[0]
      });
    } catch (error) {
      res.status(500).json({ status: 'erro', erro: error.message });
    }
  },

  // 5. DAR BAIXA / PAGAR TÍTULO EM CONTAS A PAGAR
  pagarConta: async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { id } = req.params;
      const { forma_pagamento } = req.body || {};

      const check = await client.query('SELECT * FROM conta_pagar WHERE id = $1 FOR UPDATE', [id]);
      if (check.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'erro', erro: 'Título não encontrado em Contas a Pagar.' });
      }

      const atual = check.rows[0];
      if (atual.status === 'PAGO') {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'erro', erro: 'Este título já consta como PAGO.' });
      }
      if (atual.status === 'CANCELADO') {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'erro', erro: 'Não é possível pagar um título cancelado.' });
      }

      const formaFinal = forma_pagamento ? String(forma_pagamento).toUpperCase() : atual.forma_pagamento;
      const updated = await client.query(
        `UPDATE conta_pagar
         SET status = 'PAGO',
             data_pagamento = CURRENT_DATE,
             forma_pagamento = $1
         WHERE id = $2
         RETURNING *`,
        [formaFinal, id]
      );

      await client.query('COMMIT');
      res.json({
        status: 'sucesso',
        mensagem: `Título #${id} (${atual.fornecedor}) baixado como PAGO com sucesso!`,
        conta: updated.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      res.status(500).json({ status: 'erro', erro: error.message });
    } finally {
      client.release();
    }
  }
};

module.exports = financeiroController;
