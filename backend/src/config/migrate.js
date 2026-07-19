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
        ALTER TABLE colaborador ADD COLUMN IF NOT EXISTS meta_diaria_individual INT DEFAULT 350;
        ALTER TABLE ordem_producao ADD COLUMN IF NOT EXISTS categoria_producao VARCHAR(50);
        ALTER TABLE ordem_producao ADD COLUMN IF NOT EXISTS data_programada DATE;
    `);
    await pool.query(`
        UPDATE colaborador SET meta_diaria_individual = meta_diaria WHERE meta_diaria_individual IS NULL;
        UPDATE ordem_producao SET categoria_producao = (
            SELECT COALESCE(p.categoria, 'Geral') FROM produto p WHERE p.id = ordem_producao.produto_id
        ) WHERE categoria_producao IS NULL;
    `);
    console.log('✅ Migrações verificadas (receitas, estoque produto, metas e categorias)');
}

module.exports = { runMigrations };
