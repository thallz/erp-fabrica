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

    // Sementes (Seeding) de Exemplo para duas camadas
    try {
        const massas = await pool.query("SELECT id FROM receita WHERE nome = 'Massa Tortinha'");
        let massaId, recheioId;
        if (massas.rows.length === 0) {
            const r1 = await pool.query(
                "INSERT INTO receita (nome, categoria, peso_total) VALUES ('Massa Tortinha', 'Massa', 10.0) RETURNING id"
            );
            massaId = r1.rows[0].id;
            const r2 = await pool.query(
                "INSERT INTO receita (nome, categoria, peso_total) VALUES ('Recheio de Frango', 'Recheio', 10.0) RETURNING id"
            );
            recheioId = r2.rows[0].id;

            const insFarinha = await pool.query("SELECT id FROM insumo WHERE nome ILIKE '%farinha%' LIMIT 1");
            const insFrango = await pool.query("SELECT id FROM insumo WHERE nome ILIKE '%sassami%' OR nome ILIKE '%frango%' LIMIT 1");
            
            if (insFarinha.rows.length > 0) {
                await pool.query(
                    "INSERT INTO receita_item (receita_id, tipo_origem, origem_id, nome, quantidade_gramas) VALUES ($1, 'materia', $2, 'Farinha', 5000.0)",
                    [massaId, insFarinha.rows[0].id]
                );
            }
            if (insFrango.rows.length > 0) {
                await pool.query(
                    "INSERT INTO receita_item (receita_id, tipo_origem, origem_id, nome, quantidade_gramas) VALUES ($1, 'materia', $2, 'Frango', 6000.0)",
                    [recheioId, insFrango.rows[0].id]
                );
            }
        } else {
            massaId = massas.rows[0].id;
            const recheios = await pool.query("SELECT id FROM receita WHERE nome = 'Recheio de Frango'");
            recheioId = recheios.rows[0].id;
        }

        // Vincular ao produto Tortinha (ID 31) se ele existir
        const prodCheck = await pool.query("SELECT id FROM produto WHERE id = 31");
        if (prodCheck.rows.length > 0) {
            const link = await pool.query("SELECT * FROM ficha_tecnica_receita WHERE produto_id = 31");
            if (link.rows.length === 0) {
                await pool.query(
                    "INSERT INTO ficha_tecnica_receita (produto_id, receita_id, quantidade_necessaria) VALUES (31, $1, 0.05), (31, $2, 0.03)",
                    [massaId, recheioId]
                );
            }
        }
    } catch (e) {
        console.log("Aviso nas sementes de receitas de exemplo:", e.message);
    }

    console.log('✅ Migrações verificadas (receitas, estoque produto, metas, eh_novato, categoria_producao e duas camadas)');

    // Migration: tabela de categorias dinâmicas
    await pool.query(`
        CREATE TABLE IF NOT EXISTS categoria (
            id   SERIAL PRIMARY KEY,
            nome VARCHAR(50) NOT NULL,
            tipo VARCHAR(20) NOT NULL CHECK (tipo IN ('INSUMO', 'RECEITA', 'PRODUTO')),
            UNIQUE(nome, tipo)
        );
    `);

    // Seeds padrão — inseridos apenas se ainda não existirem
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

    console.log('✅ Tabela de categorias dinâmicas verificada');
}

module.exports = { runMigrations };
