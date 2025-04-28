# API de Captura de Links de Fotos de Produtos

Esta API permite buscar links de fotos de produtos em lojas SmartPDV Store a partir de suas referências.

## Instalação

1. Clone este repositório
2. Instale as dependências:
   ```bash
   npm install
   ```

## Uso

Inicie a API:
```bash
node api.js
```

A API ficará disponível em `http://localhost:3000`.

### Endpoint

#### POST `/fotos`

**Body JSON:**
```json
{
  "loja": "brunastylosa",
  "referencias": ["0050179", "0050193"]
}
```

**Resposta:**
```json
{
  "links": [
    "https://storeimg.smartpdvstore.com/00012009/74/0050179_28_659875010@1000_750.webp",
    "https://storeimg.smartpdvstore.com/00012009/74/0050193_28_492450583@1000_750.webp"
  ]
}
```

Se uma referência não tiver foto, o valor correspondente será `null`.

---

**v1.0.0 - Captando** 