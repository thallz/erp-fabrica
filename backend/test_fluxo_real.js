const pool = require('./src/config/db');

async function testarFluxoReal() {
    const client = await pool.connect();
    try {
        console.log('🧪 ========================================================');
        console.log('🧪 INICIANDO AUDITOR AUTOMÁTICO DE FLUXO REAL');
        console.log('🧪 ========================================================\n');

        // 1. Limpeza total preliminar
        console.log('🧹 1. Resetando banco de dados para estado virgem...');
        const resTables = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
              AND table_type = 'BASE TABLE'
              AND table_name != 'tipo_intercorrencia'
        `);
        const tables = resTables.rows.map(r => `"${r.table_name}"`);
        if (tables.length > 0) {
            await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
        }

        // 2. Criar Insumo (Farinha com 10kg)
        console.log('🌾 2. Criando Insumo Farinha de Trigo com 10kg...');
        const insumoRes = await client.query(
            `INSERT INTO insumo (nome, categoria, unidade_medida, custo_unitario, estoque_atual, preco_pago, peso_embalagem, tipo_medida)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            ['Farinha de Trigo', 'Farinha', 'kg', 5.0, 10.0, 50.0, 10000, 'Peso']
        );
        const farinhaId = insumoRes.rows[0].id;
        console.log(`   -> Farinha cadastrada: ID ${farinhaId}, Estoque Inicial = 10.0 kg`);

        // 3. Criar Receita (Massa - 1kg de rendimento, consome 1000g de Farinha)
        console.log('🥣 3. Criando Receita de Massa (Rendimento 1kg, usa 1kg de Farinha)...');
        const receitaRes = await client.query(
            `INSERT INTO receita (nome, categoria, custo_total, peso_total, custo_por_kg, estoque_atual)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            ['Massa de Coxinha', 'Massa', 5.0, 1.0, 5.0, 0.0]
        );
        const receitaId = receitaRes.rows[0].id;

        // Inserir item na receita (1000g de farinha)
        await client.query(
            `INSERT INTO receita_item (receita_id, tipo_origem, origem_id, nome, quantidade_gramas, custo)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [receitaId, 'materia', farinhaId, 'Farinha de Trigo', 1000, 5.0]
        );
        console.log(`   -> Receita cadastrada: ID ${receitaId}, 1000g de Farinha vinculados.`);

        // 4. Criar Produto (Coxinha) vinculado à Receita (100g = 0.1kg por Coxinha)
        console.log('🍗 4. Criando Produto Coxinha (usa 0.1kg de Massa por unidade)...');
        const produtoRes = await client.query(
            `INSERT INTO produto (nome, categoria, estoque_atual, preco_venda, categoria_producao)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            ['Coxinha de Frango', 'Frito', 0, 5.0, 'Frito']
        );
        const produtoId = produtoRes.rows[0].id;

        // Ficha técnica da Coxinha
        await client.query(
            `INSERT INTO ficha_tecnica_receita (produto_id, receita_id, quantidade_necessaria)
             VALUES ($1, $2, $3)`,
            [produtoId, receitaId, 0.1]
        );
        console.log(`   -> Produto cadastrado: ID ${produtoId}, Estoque Inicial na Câmara Fria = 0 un.`);

        // 5. Criar Cliente para Venda
        const clienteRes = await client.query(
            `INSERT INTO cliente (razao_social, cnpj, telefone)
             VALUES ($1, $2, $3) RETURNING id`,
            ['Buffet Sonho Meu', '12345678000199', '11999998888']
        );
        const clienteId = clienteRes.rows[0].id;

        // 6. Simular Venda de 10 unidades via controller / API
        console.log('\n💰 5. Simulando Pedido de Venda de 10 unidades de Coxinha...');
        const comercialController = require('./src/controllers/comercialController');
        
        let pedidoResponse = null;
        const fakeReq = {
            body: {
                cliente_id: clienteId,
                data_entrega: '2026-08-20',
                itens: [
                    { produto_id: produtoId, quantidade: 10, preco_unitario: 5.0 }
                ]
            }
        };
        const fakeRes = {
            status: function(code) { this.statusCode = code; return this; },
            json: function(data) { pedidoResponse = data; return this; }
        };

        await comercialController.lancarPedido(fakeReq, fakeRes);
        console.log(`   -> Resposta do Lançamento: ${pedidoResponse.mensagem}`);

        // 7. Verificar se gerou as OPs
        console.log('\n📋 6. Verificando geração de Ordens de Produção (OPs)...');
        const ops = await client.query(`
            SELECT id, produto_id, quantidade_planejada, status, tipo_op, receita_id 
            FROM ordem_producao 
            ORDER BY id ASC
        `);

        if (ops.rows.length === 0) {
            throw new Error('❌ ERRO: Nenhuma OP foi gerada após a venda.');
        }

        console.log(`   -> Total de OPs geradas: ${ops.rows.length}`);
        ops.rows.forEach(op => {
            console.log(`      OP #${op.id} | Tipo: ${op.tipo_op} | Qtd: ${op.quantidade_planejada} | Status: ${op.status} | Receita: ${op.receita_id || '-'}`);
        });

        const opPreparo = ops.rows.find(o => o.tipo_op === 'PREPARO');
        const opMontagem = ops.rows.find(o => o.tipo_op === 'MONTAGEM');

        if (!opMontagem) throw new Error('❌ ERRO: OP de MONTAGEM não foi gerada.');
        if (!opPreparo) throw new Error('❌ ERRO: OP de PREPARO (Massa) não foi gerada para suprir a demanda.');

        // 8. Simular Finalização da OP de PREPARO
        console.log(`\n🥣 7. Finalizando OP de PREPARO #${opPreparo.id} (Cozinha)...`);
        const producaoController = require('./src/controllers/producaoController');

        let resPrep = null;
        const fakeReqPrep = { params: { id: opPreparo.id } };
        const fakeResPrep = {
            status: function(c) { this.statusCode = c; return this; },
            json: function(d) { resPrep = d; return this; }
        };
        await producaoController.finalizarOP(fakeReqPrep, fakeResPrep);
        if (resPrep?.status === 'erro') throw new Error(`Falha ao finalizar OP Preparo: ${resPrep.erro}`);

        // Verificar Farinha após preparo
        const farinhaAposPrep = await client.query('SELECT estoque_atual FROM insumo WHERE id = $1', [farinhaId]);
        const qtdFarinha1 = parseFloat(farinhaAposPrep.rows[0].estoque_atual);
        console.log(`   -> Estoque de Farinha após Preparo: ${qtdFarinha1.toFixed(2)} kg (esperado: 9.00 kg)`);

        // Verificar Coxinha na câmara fria (não deve ter aumentado ainda)
        const coxinhaAposPrep = await client.query('SELECT estoque_atual FROM produto WHERE id = $1', [produtoId]);
        const qtdCoxinha1 = parseInt(coxinhaAposPrep.rows[0].estoque_atual, 10);
        console.log(`   -> Estoque de Coxinha após Preparo: ${qtdCoxinha1} un (esperado: 0 un)`);

        if (qtdCoxinha1 !== 0) {
            throw new Error(`❌ ERRO: OP de PREPARO creditou indevidamente a Câmara Fria! Estoque Coxinha: ${qtdCoxinha1}`);
        }

        // 9. Simular Finalização da OP de MONTAGEM
        console.log(`\n🛠️ 8. Finalizando OP de MONTAGEM #${opMontagem.id} (Bancada de Salgados)...`);
        let resMont = null;
        const fakeReqMont = { params: { id: opMontagem.id } };
        const fakeResMont = {
            status: function(c) { this.statusCode = c; return this; },
            json: function(d) { resMont = d; return this; }
        };
        await producaoController.finalizarOP(fakeReqMont, fakeResMont);
        if (resMont?.status === 'erro') throw new Error(`Falha ao finalizar OP Montagem: ${resMont.erro}`);

        // 10. Verificações Finais
        console.log('\n📊 9. Auditoria Final dos Saldos de Estoque:');
        const farinhaFinalRes = await client.query('SELECT estoque_atual FROM insumo WHERE id = $1', [farinhaId]);
        const coxinhaFinalRes = await client.query('SELECT estoque_atual FROM produto WHERE id = $1', [produtoId]);

        const estoqueFarinhaFinal = parseFloat(farinhaFinalRes.rows[0].estoque_atual);
        const estoqueCoxinhaFinal = parseInt(coxinhaFinalRes.rows[0].estoque_atual, 10);

        console.log(`   -> Estoque Final Farinha: ${estoqueFarinhaFinal.toFixed(2)} kg (Esperado: 9.00 kg)`);
        console.log(`   -> Estoque Final Coxinha: ${estoqueCoxinhaFinal} un (Esperado: 10 un)`);

        const farinhaOk = Math.abs(estoqueFarinhaFinal - 9.0) < 0.001;
        const coxinhaOk = estoqueCoxinhaFinal === 10;

        if (farinhaOk && coxinhaOk) {
            console.log('\n========================================================');
            console.log('✅ TESTE DE LOGICA: SUCESSO');
            console.log('========================================================\n');
        } else {
            throw new Error(`Divergência de estoque -> Farinha: ${estoqueFarinhaFinal} (esperava 9.0), Coxinha: ${estoqueCoxinhaFinal} (esperava 10)`);
        }

    } catch (error) {
        console.error('\n========================================================');
        console.error(`❌ ERRO NA LOGICA: ${error.message}`);
        console.error('========================================================\n');
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

testarFluxoReal();
