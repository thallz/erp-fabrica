const pool = require('../src/config/db');

async function resetDatabase() {
    const client = await pool.connect();
    try {
        console.log('🔄 Iniciando Reset Total do Banco de Dados...');
        await client.query('BEGIN');

        // Buscar todas as tabelas exceto tipo_intercorrencia
        const resTables = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
              AND table_type = 'BASE TABLE'
              AND table_name != 'tipo_intercorrencia'
        `);

        const tables = resTables.rows.map(r => `"${r.table_name}"`);
        
        if (tables.length > 0) {
            const truncateSql = `TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`;
            console.log(`🧹 Executando TRUNCATE em: ${tables.join(', ')}`);
            await client.query(truncateSql);
        }

        await client.query('COMMIT');
        console.log('✅ BANCO DE DADOS 100% LIMPO E IDs REINICIADOS PARA 1 COM SUCESSO!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Erro ao resetar banco de dados:', error);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

resetDatabase();
