FROM node:18

RUN apt update && apt install createrepo-c dpkg-dev apt-utils gnupg2 gzip -y && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/service

# Copy PJ, changes should invalidate entire image
COPY package.json yarn.lock /opt/service/

# Install dependencies
RUN yarn --cache-folder ../ycache

# Copy commong typings
COPY typings /opt/service/typings

# Copy TS configs
COPY tsconfig* /opt/service/

# Build backend
COPY src /opt/service/src

# Build Frontend

COPY public /opt/service/public

COPY webpack.*.js postcss.config.js README.md /opt/service/

RUN yarn build:server && yarn build:fe:prod && yarn --production --cache-folder ../ycache

COPY config.js /opt/service/config.js

EXPOSE 8080

ENTRYPOINT ["npm", "run", "start:server:prod", "--"]
