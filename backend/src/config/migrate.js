const pool = require('./db');

async function runMigrations() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS receita (
            id SERIAL PRIMARY KEY,
            nome VARCHAR(100) NOT NULL,
            categoria VARCHAR(50) DEFAULT 'Geral',
            custo_total DECIMAL(12, 4) DEFAULT 0,
            peso_total DECIMAL(12, 4) DEFAULT 0,
            custo_por_kg DECIMAL(12, 4) DEFAULT 0,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS receita_item (
            id SERIAL PRIMARY KEY,
            receita_id INT NOT NULL REFERENCES receita(id) ON DELETE CASCADE,
            tipo_origem VARCHAR(10) NOT NULL CHECK (tipo_origem IN ('materia', 'receita')),
            origem_id INT NOT NULL,
            nome VARCHAR(100) NOT NULL,
            quantidade_gramas DECIMAL(12, 4) NOT NULL,
            custo_unitario DECIMAL(12, 4) DEFAULT 0,
            custo DECIMAL(12, 4) DEFAULT 0
        );
    `);
    await pool.query(`
        ALTER TABLE produto ADD COLUMN IF NOT EXISTS estoque_atual INT DEFAULT 0;
        ALTER TABLE produto ADD COLUMN IF NOT EXISTS peso_produtividade FLOAT DEFAULT 1.0;
        ALTER TABLE produto ADD COLUMN IF NOT EXISTS categoria VARCHAR(50) DEFAULT 'Geral';
        ALTER TABLE produto ADD COLUMN IF NOT EXISTS categoria_producao VARCHAR(50) DEFAULT 'Geral';
        ALTER TABLE produto ADD COLUMN IF NOT EXISTS embalagem_id INT REFERENCES insumo(id) ON DELETE SET NULL;
        ALTER TABLE produto ADD COLUMN IF NOT EXISTS capacidade_embalagem DECIMAL(12, 4) DEFAULT 1;
        ALTER TABLE produto ADD COLUMN IF NOT EXISTS rateio_embalagem DECIMAL(12, 4) DEFAULT 0;
        ALTER TABLE colaborador ADD COLUMN IF NOT EXISTS meta_diaria_individual INT DEFAULT 350;
        ALTER TABLE colaborador ADD COLUMN IF NOT EXISTS eh_novato BOOLEAN DEFAULT FALSE;
        ALTER TABLE colaborador ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Ativo';
        ALTER TABLE ordem_producao ADD COLUMN IF NOT EXISTS categoria_producao VARCHAR(50);
        ALTER TABLE ordem_producao ADD COLUMN IF NOT EXISTS data_programada DATE;
        ALTER TABLE insumo ADD COLUMN IF NOT EXISTS categoria VARCHAR(50) DEFAULT 'Outros';
        ALTER TABLE insumo ADD COLUMN IF NOT EXISTS preco_pago DECIMAL(12, 4) DEFAULT 0;
        ALTER TABLE insumo ADD COLUMN IF NOT EXISTS peso_embalagem DECIMAL(12, 4) DEFAULT 1000;
        ALTER TABLE insumo ADD COLUMN IF NOT EXISTS tipo_medida VARCHAR(20) DEFAULT 'Peso';
        ALTER TABLE insumo ALTER COLUMN estoque_atual TYPE DECIMAL(12, 4);
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ficha_tecnica_receita (
            produto_id INT REFERENCES produto(id) ON DELETE CASCADE,
            receita_id INT REFERENCES receita(id) ON DELETE RESTRICT,
            quantidade_necessaria DECIMAL(12, 4) NOT NULL,
            PRIMARY KEY (produto_id, receita_id)
        );

        CREATE TABLE IF NOT EXISTS ficha_tecnica_produto (
            id SERIAL PRIMARY KEY,
            produto_id INT REFERENCES produto(id) ON DELETE CASCADE,
            receita_id INT REFERENCES receita(id) ON DELETE CASCADE,
            quantidade_gramas DECIMAL(10, 2) NOT NULL
        );
    `);
    await pool.query(`
        ALTER TABLE ordem_producao ADD COLUMN IF NOT EXISTS tipo_op VARCHAR(15) DEFAULT 'MONTAGEM' CHECK (tipo_op IN ('PREPARO', 'MONTAGEM'));
        ALTER TABLE ordem_producao ADD COLUMN IF NOT EXISTS receita_id INT REFERENCES receita(id) ON DELETE SET NULL;
        ALTER TABLE ordem_producao ADD COLUMN IF NOT EXISTS parent_op_id INT REFERENCES ordem_producao(id) ON DELETE SET NULL;
        ALTER TABLE receita ADD COLUMN IF NOT EXISTS estoque_atual DECIMAL(12, 4) DEFAULT 0;
    `);
    await pool.query(`
        UPDATE colaborador SET meta_diaria_individual = meta_diaria WHERE meta_diaria_individual IS NULL;
        UPDATE produto SET categoria_producao = categoria WHERE (categoria_producao = 'Geral' OR categoria_producao IS NULL) AND categoria IS NOT NULL;
        UPDATE ordem_producao SET categoria_producao = (
            SELECT COALESCE(p.categoria_producao, 'Geral') FROM produto p WHERE p.id = ordem_producao.produto_id
        ) WHERE categoria_producao IS NULL;
    `);

    console.log('✅ Migrações estruturais verificadas com sucesso');

    // Migration: tabela de categorias dinâmicas
    await pool.query(`
        CREATE TABLE IF NOT EXISTS categoria (
            id   SERIAL PRIMARY KEY,
            nome VARCHAR(50) NOT NULL,
            tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('INSUMO', 'RECEITA', 'PRODUTO')),
            UNIQUE(nome, tipo)
        );
    `);

    // Seeds padrão de categorias — inseridos apenas se ainda não existirem
    await pool.query(`
        INSERT INTO categoria (nome, tipo) VALUES
            ('Farináceo',    'INSUMO'),
            ('Proteína',     'INSUMO'),
            ('Laticínio',    'INSUMO'),
            ('Tempero',      'INSUMO'),
            ('Gordura',      'INSUMO'),
            ('Embalagem',    'INSUMO'),
            ('Outros',       'INSUMO'),
            ('Massa',        'RECEITA'),
            ('Recheio',      'RECEITA'),
            ('Molho',        'RECEITA'),
            ('Tempero',      'RECEITA'),
            ('Frito',        'PRODUTO'),
            ('Assado',       'PRODUTO'),
            ('Mini',         'PRODUTO'),
            ('Doce',         'PRODUTO'),
            ('Outros',       'PRODUTO')
        ON CONFLICT (nome, tipo) DO NOTHING;
    `);

    // Migration: campos adicionais na tabela cliente
    await pool.query(`
        ALTER TABLE cliente ADD COLUMN IF NOT EXISTS endereco TEXT;
        ALTER TABLE cliente ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) DEFAULT 'B2B';
    `);

    // Migration: tabela de auditoria e movimentações de estoque (Kardex / Extrato)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS movimentacao_estoque (
            id SERIAL PRIMARY KEY,
            tipo_estoque VARCHAR(20) NOT NULL CHECK (tipo_estoque IN ('MATERIA_PRIMA', 'PRODUTO_ACABADO')),
            insumo_id INT REFERENCES insumo(id) ON DELETE SET NULL,
            produto_id INT REFERENCES produto(id) ON DELETE SET NULL,
            tipo_movimento VARCHAR(10) NOT NULL CHECK (tipo_movimento IN ('ENTRADA', 'SAIDA', 'AJUSTE', 'PERDA')),
            motivo VARCHAR(50) NOT NULL,
            quantidade DECIMAL(12, 4) NOT NULL,
            unidade_medida VARCHAR(10) NOT NULL,
            custo_unitario_momento DECIMAL(12, 4) DEFAULT 0,
            saldo_anterior DECIMAL(12, 4) NOT NULL,
            saldo_posterior DECIMAL(12, 4) NOT NULL,
            documento_ref VARCHAR(100),
            observacao TEXT,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_mov_estoque_tipo_data ON movimentacao_estoque (tipo_estoque, criado_em DESC);
        CREATE INDEX IF NOT EXISTS idx_mov_estoque_insumo ON movimentacao_estoque (insumo_id);
        CREATE INDEX IF NOT EXISTS idx_mov_estoque_produto ON movimentacao_estoque (produto_id);
    `);

    // Migration: tabela de Contas a Pagar integrada ao Almoxarifado (NF)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS conta_pagar (
            id SERIAL PRIMARY KEY,
            fornecedor VARCHAR(150) NOT NULL,
            descricao VARCHAR(200) NOT NULL,
            valor DECIMAL(12, 2) NOT NULL,
            data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
            data_vencimento DATE NOT NULL,
            data_pagamento DATE NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'PAGO', 'CANCELADO')),
            forma_pagamento VARCHAR(50) NOT NULL DEFAULT 'BOLETO',
            documento_ref VARCHAR(100),
            movimentacao_estoque_id INT REFERENCES movimentacao_estoque(id) ON DELETE SET NULL,
            observacao TEXT,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_conta_pagar_status_venc ON conta_pagar (status, data_vencimento);
    `);

    // Migration: tabelas de Orçamentos Comerciais (Cotações B2B)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS orcamento (
            id SERIAL PRIMARY KEY,
            cliente_id INT REFERENCES cliente(id) ON DELETE RESTRICT,
            data_orcamento TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            data_validade DATE NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'APROVADO', 'RECUSADO')),
            valor_total DECIMAL(10, 2) DEFAULT 0.00,
            observacao TEXT,
            pedido_id INT REFERENCES pedido(id) ON DELETE SET NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS item_orcamento (
            orcamento_id INT REFERENCES orcamento(id) ON DELETE CASCADE,
            produto_id INT REFERENCES produto(id) ON DELETE RESTRICT,
            quantidade INT NOT NULL,
            preco_unitario DECIMAL(10, 2) NOT NULL,
            PRIMARY KEY (orcamento_id, produto_id)
        );

        CREATE INDEX IF NOT EXISTS idx_orcamento_status_validade ON orcamento (status, data_validade);
    `);

    // Migration: tabela de Contas a Receber integrada aos Pedidos B2B
    await pool.query(`
        CREATE TABLE IF NOT EXISTS conta_receber (
            id SERIAL PRIMARY KEY,
            cliente_id INT REFERENCES cliente(id) ON DELETE RESTRICT,
            pedido_id INT REFERENCES pedido(id) ON DELETE CASCADE,
            descricao VARCHAR(200) NOT NULL,
            valor DECIMAL(10, 2) NOT NULL,
            data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
            data_vencimento DATE NOT NULL,
            data_recebimento DATE NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'RECEBIDO', 'CANCELADO')),
            forma_pagamento VARCHAR(50) NOT NULL DEFAULT 'BOLETO',
            documento_ref VARCHAR(100),
            observacao TEXT,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_conta_receber_status_venc ON conta_receber (status, data_vencimento);
    `);

    console.log('✅ Tabela de categorias dinâmicas, Kardex, Contas a Pagar/Receber e Orçamentos verificados');
}

module.exports = { runMigrations };
