var express=require('express'),
    exec = require('child_process').exec,
    app = express(),
    request = require('request'),
    url = require('url'),
    fs = require('fs'),
    bodyParser = require('body-parser'),
    config = require('./config');

var services = [];
var fillServices = function() {
  //docker ps --format "{{.Names}}" -f "name=ci-jenk"|grep -w ci-jenk|wc -l
    request(config.docker+'/containers/json', function(error, response, body) {
      services = [];
      if(!error && response.statusCode == 200) {
        try {
          body = JSON.parse(body);
          body.forEach(function(service) {
            service.Names.forEach(function(name) {
              services.push(name.substr(1));
            });
          });
        } catch(e) {
          console.log(e);
        }
      } else {
        console.log(error||body);
      }
    });
}
fillServices();
setInterval(fillServices, 10000);

/*app.use(function(req, res, next) {
  console.log(req.method+' '+req.url);
  next();
})*/

app.use(bodyParser.raw({limit: '50mb'}));

app.use(function(req, res, next) {
  //var hostname = url.parse(req.headers.host).hostname;
  var match;
  if(!(match = req.headers.host.match(/^([^.]+).*$/))) return res.status(404).send("Page Not Found");
  req.serviceName = match[1];
  if(services.indexOf(req.serviceName) === -1) {
    return request(config.docker+'/containers/'+req.serviceName+'/json', function(error, response, body) {
      if(!error && response.statusCode == 200) {
        try {
          body = JSON.parse(body);
          if(body.State.Running)
            return next();
          else
            return res.status(503).send("Service  Unavailable");
        } catch(e) {
          console.log(e)
        }
      }
      res.status(404).send("Page Not Found");
    });
  }
  next()
}, function(req, res, next) {
  fs.stat('/run/services/'+req.serviceName+'/service.sock', function(error, stat) {
    if(error) return res.status(500).send("Internal Server Error");
    var options = {
      url: 'http://unix:/run/services/'+req.serviceName+'/service.sock:'+req.url,
      method: req.method,
      headers: req.headers
    };
    if(["POST", "PUT", "PATCH"].indexOf(req.method) !== -1) {
      options.body = req.body;
    }
    req.pipe(request(options)).pipe(res);
  });
});

app.listen(80);
