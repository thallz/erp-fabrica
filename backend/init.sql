-- ==========================================
-- SCRIPT DE INICIALIZAÇÃO: init.sql
-- BANCO DE DADOS: banco-dados-erp
-- ==========================================

-- 1. ALMOXARIFADO E INSUMOS
CREATE TABLE insumo (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    unidade_medida VARCHAR(10) NOT NULL, -- Ex: 'kg', 'g', 'l', 'ml', 'un'
    custo_unitario DECIMAL(10, 4) NOT NULL, -- Precisão extra para centavos
    estoque_atual DECIMAL(10, 4) DEFAULT 0.0000
);

-- 2. EMBALAGENS (Controle separado de insumos por ter lógica diferente no CMV)
CREATE TABLE embalagem (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    custo_unitario DECIMAL(10, 4) NOT NULL,
    estoque_atual INT DEFAULT 0
);

-- 3. PRODUTOS ACABADOS (O que vai para a venda)
CREATE TABLE produto (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    preco_venda DECIMAL(10, 2) NOT NULL,
    cmv_estimado DECIMAL(10, 2), -- Atualizado via API toda vez que um insumo muda de preço
    margem_contribuicao DECIMAL(5, 2), -- Porcentagem (%)
    estoque_atual INT DEFAULT 0, -- Câmara Fria (produto acabado)
    peso_produtividade FLOAT DEFAULT 1.0,
    categoria VARCHAR(50) DEFAULT 'Geral',
    categoria_producao VARCHAR(50) DEFAULT 'Geral'
);

-- 4. FICHAS TÉCNICAS (A "Receita" do Produto para Cálculo em Cascata)
CREATE TABLE ficha_tecnica_insumo (
    produto_id INT REFERENCES produto(id) ON DELETE CASCADE,
    insumo_id INT REFERENCES insumo(id) ON DELETE RESTRICT,
    quantidade DECIMAL(10, 4) NOT NULL, -- Quanto de insumo vai em 1 lote/unidade
    PRIMARY KEY (produto_id, insumo_id)
);

CREATE TABLE ficha_tecnica_embalagem (
    produto_id INT REFERENCES produto(id) ON DELETE CASCADE,
    embalagem_id INT REFERENCES embalagem(id) ON DELETE RESTRICT,
    quantidade INT NOT NULL,
    PRIMARY KEY (produto_id, embalagem_id)
);

-- 4b. RECEITAS (Massas, Recheios e Pré-Preparos)
CREATE TABLE receita (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    categoria VARCHAR(50) DEFAULT 'Geral',
    custo_total DECIMAL(12, 4) DEFAULT 0,
    peso_total DECIMAL(12, 4) DEFAULT 0,
    custo_por_kg DECIMAL(12, 4) DEFAULT 0,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE receita_item (
    id SERIAL PRIMARY KEY,
    receita_id INT NOT NULL REFERENCES receita(id) ON DELETE CASCADE,
    tipo_origem VARCHAR(10) NOT NULL CHECK (tipo_origem IN ('materia', 'receita')),
    origem_id INT NOT NULL,
    nome VARCHAR(100) NOT NULL,
    quantidade_gramas DECIMAL(12, 4) NOT NULL,
    custo_unitario DECIMAL(12, 4) DEFAULT 0,
    custo DECIMAL(12, 4) DEFAULT 0
);

-- 5. CONFIGURAÇÃO DE INTERCORRÊNCIAS (Padrões da Fábrica)
CREATE TABLE tipo_intercorrencia (
    codigo VARCHAR(2) PRIMARY KEY,
    descricao VARCHAR(100) NOT NULL,
    afeta_meta BOOLEAN DEFAULT TRUE
);

-- Populando as intercorrências padrão que você definiu
INSERT INTO tipo_intercorrencia (codigo, descricao) VALUES
('M1', 'Manutenção Mecânica (Falha em Equipamento)'),
('E1', 'Falta de Energia / Instabilidade Elétrica'),
('P1', 'Problema de Processo / Qualidade de Massa/Recheio'),
('O1', 'Ociosidade / Falta de Demanda ou Insumo');

-- 5b. COLABORADORES (Equipe de Produção)
CREATE TABLE colaborador (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    meta_diaria INT DEFAULT 350, -- Meta padrão de 350 unidades por dia
    meta_diaria_individual INT DEFAULT 350,
    eh_novato BOOLEAN DEFAULT FALSE,
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inserir alguns colaboradores de exemplo
INSERT INTO colaborador (nome, meta_diaria) VALUES
('Maria Silva', 350),
('João Santos', 400),
('Ana Costa', 350);

-- 6. FILA DE PRODUÇÃO (Bateladas)
CREATE TABLE ordem_producao (
    id SERIAL PRIMARY KEY,
    produto_id INT REFERENCES produto(id),
    quantidade_planejada INT NOT NULL,
    quantidade_realizada INT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'FILA', -- 'FILA', 'PRODUZINDO', 'CONCLUIDA', 'PAUSADA'
    data_inicio TIMESTAMP,
    data_fim TIMESTAMP,
    colaborador_id INT REFERENCES colaborador(id), -- Colaborador responsável
    data_programada DATE, -- Data planejada para produção
    categoria_producao VARCHAR(50),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. APONTAMENTO DE CHÃO DE FÁBRICA (Onde os códigos entram)
CREATE TABLE apontamento_intercorrencia (
    id SERIAL PRIMARY KEY,
    ordem_producao_id INT REFERENCES ordem_producao(id) ON DELETE CASCADE,
    codigo_intercorrencia VARCHAR(2) REFERENCES tipo_intercorrencia(codigo),
    tempo_parada_minutos INT NOT NULL,
    observacao TEXT,
    registrado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. CLIENTES (B2B)
CREATE TABLE cliente (
    id SERIAL PRIMARY KEY,
    razao_social VARCHAR(200) NOT NULL,
    cnpj VARCHAR(20) UNIQUE NOT NULL,
    telefone VARCHAR(20),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. PEDIDOS (Vendas)
CREATE TABLE pedido (
    id SERIAL PRIMARY KEY,
    cliente_id INT REFERENCES cliente(id) ON DELETE RESTRICT,
    data_pedido TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_entrega DATE,
    status VARCHAR(20) DEFAULT 'CRIADO', -- 'CRIADO', 'PRODUZINDO', 'FATURADO', 'ENTREGUE'
    valor_total DECIMAL(10, 2) DEFAULT 0.00
);

-- 10. ITENS DO PEDIDO
CREATE TABLE item_pedido (
    pedido_id INT REFERENCES pedido(id) ON DELETE CASCADE,
    produto_id INT REFERENCES produto(id) ON DELETE RESTRICT,
    quantidade INT NOT NULL,
    preco_unitario DECIMAL(10, 2) NOT NULL,
    PRIMARY KEY (pedido_id, produto_id)
);


-- 11. AUDITORIA E MOVIMENTAÇÕES DE ESTOQUE (KARDEX / EXTRATO)
CREATE TABLE IF NOT EXISTS movimentacao_estoque (
    id SERIAL PRIMARY KEY,
    tipo_estoque VARCHAR(20) NOT NULL CHECK (tipo_estoque IN ('MATERIA_PRIMA', 'PRODUTO_ACABADO')),
    insumo_id INT REFERENCES insumo(id) ON DELETE SET NULL,
    produto_id INT REFERENCES produto(id) ON DELETE SET NULL,
    tipo_movimento VARCHAR(10) NOT NULL CHECK (tipo_movimento IN ('ENTRADA', 'SAIDA', 'AJUSTE', 'PERDA')),
    motivo VARCHAR(50) NOT NULL, -- Ex: 'COMPRA_FORNECEDOR', 'CONSUMO_PRODUCAO', 'PRODUCAO_CONCLUIDA', 'VENDA_PEDIDO', 'INVENTARIO_BALANCO', 'AVARIA_DESCARTE'
    quantidade DECIMAL(12, 4) NOT NULL,
    unidade_medida VARCHAR(10) NOT NULL,
    custo_unitario_momento DECIMAL(12, 4) DEFAULT 0,
    saldo_anterior DECIMAL(12, 4) NOT NULL,
    saldo_posterior DECIMAL(12, 4) NOT NULL,
    documento_ref VARCHAR(100), -- Nº NF, Nº Pedido ou Nº OP
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mov_estoque_tipo_data ON movimentacao_estoque (tipo_estoque, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_mov_estoque_insumo ON movimentacao_estoque (insumo_id);
CREATE INDEX IF NOT EXISTS idx_mov_estoque_produto ON movimentacao_estoque (produto_id);

-- 12. CONTAS A PAGAR (INTEGRAÇÃO COMPRAS / NOTAS FISCAIS & DESPESAS)
CREATE TABLE IF NOT EXISTS conta_pagar (
    id SERIAL PRIMARY KEY,
    fornecedor VARCHAR(150) NOT NULL,
    descricao VARCHAR(200) NOT NULL,
    valor DECIMAL(12, 2) NOT NULL,
    data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
    data_vencimento DATE NOT NULL,
    data_pagamento DATE NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'PAGO', 'CANCELADO')),
    forma_pagamento VARCHAR(50) NOT NULL DEFAULT 'BOLETO', -- 'BOLETO', 'PIX', 'DINHEIRO', 'CARTAO'
    documento_ref VARCHAR(100), -- Ex: "NF 1024"
    movimentacao_estoque_id INT REFERENCES movimentacao_estoque(id) ON DELETE SET NULL,
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conta_pagar_status_venc ON conta_pagar (status, data_vencimento);

-- 13. ORÇAMENTOS COMERCIAIS (COTAÇÕES B2B)
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

-- 14. CONTAS A RECEBER (INTEGRAÇÃO AUTOMÁTICA COM VENDAS / PEDIDOS B2B)
CREATE TABLE IF NOT EXISTS conta_receber (
    id SERIAL PRIMARY KEY,
    cliente_id INT REFERENCES cliente(id) ON DELETE RESTRICT,
    pedido_id INT REFERENCES pedido(id) ON DELETE CASCADE,
    descricao VARCHAR(200) NOT NULL, -- Ex: "Pedido #1 - Padaria Bella Vista"
    valor DECIMAL(10, 2) NOT NULL,
    data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
    data_vencimento DATE NOT NULL,
    data_recebimento DATE NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'RECEBIDO', 'CANCELADO')),
    forma_pagamento VARCHAR(50) NOT NULL DEFAULT 'BOLETO', -- 'BOLETO', 'PIX', 'DINHEIRO', 'CARTAO'
    documento_ref VARCHAR(100), -- Ex: "Boleto Pedido #1"
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conta_receber_status_venc ON conta_receber (status, data_vencimento);
