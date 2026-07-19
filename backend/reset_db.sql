-- SCRIPT DE RESET DE DADOS DO ERP FÁBRICA
-- Esse script limpa os dados de testes e mantém apenas a estrutura e parametrizações padrão.

-- 1. Desativar verificação de chaves estrangeiras temporariamente (PostgreSQL)
SET session_replication_role = 'replica';

-- 2. Limpar conteúdo das tabelas de dados
TRUNCATE TABLE 
    apontamento_intercorrencia,
    item_pedido,
    pedido,
    ordem_producao,
    ficha_tecnica_insumo,
    ficha_tecnica_embalagem,
    ficha_tecnica_receita,
    receita_item,
    receita,
    produto,
    insumo,
    embalagem,
    cliente,
    colaborador
RESTART IDENTITY CASCADE;

-- 3. Reativar verificação de chaves estrangeiras
SET session_replication_role = 'origin';

-- 4. Garantir que a tabela tipo_intercorrencia possui os códigos corretos
INSERT INTO tipo_intercorrencia (codigo, descricao, afeta_meta) VALUES
('M1', 'Manutenção Mecânica (Falha de Equipamento/Misturador)', TRUE),
('E1', 'Falta de Energia / Instabilidade Elétrica', TRUE),
('P1', 'Problema de Processo / Qualidade de Massa e Recheio', TRUE),
('O1', 'Ociosidade / Falta de Demanda ou Insumos', TRUE)
ON CONFLICT (codigo) DO UPDATE 
SET descricao = EXCLUDED.descricao, afeta_meta = EXCLUDED.afeta_meta;
