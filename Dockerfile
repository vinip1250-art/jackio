FROM ghcr.io/linuxserver/jackett:latest

# Instala git para clonar o repositório
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Clona seu repositório JackettIO
RUN git clone https://github.com/vinip1250-art/jackio.git /tmp/jackio

# Copia o código modificado para dentro da imagem
RUN cp -r /tmp/jackio/src/* /app/ && \
    chown -R abc:abc /app && \
    rm -rf /tmp/jackio
