FROM node:7

RUN mkdir -p /opt/project
WORKDIR /opt/project

COPY Dockerfile /opt/project/
COPY package.json /opt/project/
RUN NODE_ENV=production npm install
COPY index.js /opt/project/
COPY config /opt/project/config
COPY entrypoint.sh /opt/project/
EXPOSE 80
CMD ["npm", "start"]
