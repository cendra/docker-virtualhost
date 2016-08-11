FROM hub.psi.unc.edu.ar/base/nodejs:6.2.2

RUN mkdir -p /opt/project
WORKDIR /opt/project

COPY Dockerfile /opt/project/
COPY package.json /opt/project/
RUN npm install
COPY *.js /opt/project/
COPY config /opt/project/config
EXPOSE 80
CMD ["npm", "start"]
