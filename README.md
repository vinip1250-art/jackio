
```markdown
# Jackio 🎬

Jackio é um addon avançado para Stremio, focado em buscar, resolver e fazer streaming de torrents de forma inteligente. Construído como um fork direto do [Jackettio](https://github.com/aymene69/jackettio), o Jackio expande massivamente a compatibilidade com novos serviços de debrid, proxys, metadados e clientes de torrent, oferecendo uma experiência muito mais flexível e robusta.

---

## ✨ Principais Novidades (vs. Jackettio Original)

O Jackio vai muito além da integração padrão com Jackett e os debrids clássicos. Abaixo estão as exclusividades desta versão:

### 🚀 Novos Serviços de Debrid e Streaming
*   **TorBox (`torbox.js`)**: Suporte nativo ao serviço de debrid TorBox.
*   **StremThru (`stremthru.js` & `stremthruCache.js`)**: Integração completa com o StremThru, permitindo gerenciamento avançado de conexões e cache otimizado.
*   **TorrServer (`torrserver.js`)**: Streaming direto de torrents on-the-fly sem depender exclusivamente de serviços de debrid em nuvem.
*   **Modo Híbrido & Offcloud (`hybrid.js`, `hybrid-oc.js`, `offcloud.js`)**: Lógica avançada para combinar múltiplos provedores e suporte nativo ao Offcloud.

### 🌐 Integração com Proxys e Clientes
*   **Mediaflow Proxy (`mediaflowProxy.js`)**: Integração com Mediaflow Proxy para roteamento inteligente de tráfego, contornando bloqueios regionais e otimizando a entrega da mídia.
*   **qBittorrent Provider (`qbittorrent.js`)**: Além de enviar para debrids, o Jackio pode se comunicar diretamente com instâncias do qBittorrent.

### 📊 Enriquecimento de Dados e Automação
*   **RSS Poller (`rssPoller.js` & `rssHelpers.js`)**: Sistema de monitoramento contínuo de feeds RSS para indexação e automação de downloads.
*   **Torrent Enricher (`torrentEnrich.js` & `torrentInfos.js`)**: Algoritmos para tratar, limpar e enriquecer as informações extraídas dos torrents (tamanho, qualidade, idioma, etc.) antes de exibi-las no Stremio.
*   **Metadados Expandidos (`kitsu.js`, `tmdb.js`, `cinemeta.js`)**: Integração superior para identificar corretamente Animes (via Kitsu) e correspondência precisa de filmes/séries através do TMDB e Cinemeta.

---

## 🛠️ Tecnologias e Estrutura Suportada

Além das novidades acima, o Jackio mantém suporte aos serviços já consolidados:
*   **Indexadores**: Jackett
*   **Debrids Clássicos**: Real-Debrid, AllDebrid, Premiumize, Debrid-Link.

---

## ⚙️ Instalação (Docker)

A forma mais recomendada de executar o Jackio é via Docker.

1. Clone o repositório:
   ```bash
   git clone [https://github.com/vinip1250-art/jackio.git](https://github.com/vinip1250-art/jackio.git)
   cd jackio

```
 2. Copie o arquivo de ambiente e ajuste as variáveis:
   ```bash
   cp .env.example .env
   
   ```
 3. Inicie o container:
   ```bash
   docker compose up -d
   
   ```
## 📝 Variáveis de Ambiente (Configuração)
Certifique-se de configurar seu arquivo .env corretamente. Além das variáveis padrão do Jackettio, o Jackio permite configurar as novas integrações:
| Variável | Descrição |
|---|---|
| PORT | Porta em que o Jackio vai rodar (Padrão: 3000) |
| JACKETT_URL | URL da sua instância do Jackett |
| JACKETT_API_KEY | Sua chave de API do Jackett |
| MEDIAFLOW_PROXY_URL | URL da sua instância do Mediaflow Proxy (Opcional) |
| STREMTHRU_URL | URL do seu serviço StremThru (Opcional) |
| TORRSERVER_URL | URL da sua instância do TorrServer (Opcional) |
*(Consulte o arquivo .env.example completo para todas as opções disponíveis).*
## 📄 Licença
Este projeto é um fork do Jackettio e segue os termos de licenciamento descritos no arquivo LICENSE.
```

---

### Exemplo de `compose.yml`

Para rodar o Jackio em conjunto com outras ferramentas do seu ecossistema (como o Mediaflow Proxy e o Jackett), este é um exemplo prático de `compose.yml` que você pode adicionar à raiz do seu repositório:

```yaml
services:
  jackio:
    build: .
    container_name: jackio
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      # Configurações do Jackett
      - JACKETT_URL=http://jackett:9117
      - JACKETT_API_KEY=sua_api_key_aqui
      
      # Integrações Exclusivas do Jackio (Ajuste conforme necessidade)
      - MEDIAFLOW_PROXY_URL=http://mediaflow-proxy:8080
      - MEDIAFLOW_PROXY_PASSWORD=sua_senha_aqui
      
      - STREMTHRU_URL=http://stremthru:8080
      - TORRSERVER_URL=http://torrserver:8090
      
      # Log level e outras configurações
      - LOG_LEVEL=info
    
    # Se estiver rodando o Jackett, Mediaflow Proxy ou StremThru no mesmo compose:
    # depends_on:
    #   - jackett
    #   - mediaflow-proxy

```

