FROM node:7.8

RUN mkdir -p /opt/project
WORKDIR /opt/project

COPY Dockerfile /opt/project/
COPY package.json /opt/project/
RUN NODE_ENV=production npm install
COPY *.js /opt/project/
COPY config /opt/project/config
COPY entrypoint.sh /opt/project/
EXPOSE 80
CMD ["npm", "start"]
