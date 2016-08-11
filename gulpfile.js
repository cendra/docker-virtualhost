var gulp = require('gulp');
var package = require('./package');
var httpProxy = require('http-proxy');
var config = require('/etc/nodejs-config/'+package.name);
var Docker = require('dockerode');
var gulp_conf = require('./gulpconf');
var docker = new Docker(gulp_conf.docker);
var tar = require('gulp-tar');
var gitignore = require('gulp-gitignore');
var vfs = require('vinyl-fs');
var net = require('net');

gulp.task('default', ['docker']);

gulp.task('tar', function() {
  return vfs.src('**/*', {base: '.'}).pipe(gitignore()).pipe(tar(package.name+'.tar')).pipe(gulp.dest('/tmp/'));
});

gulp.task('docker:build', ['tar'], function dockerBuildTask(done) {
  docker.buildImage('/tmp/'+package.name+'.tar', {
    t: package.name+':'+package.version
  }, function(error, stream) {
    stream.pipe(process.stdout);
    stream.on('end', done);
  });
});

gulp.task('docker', ['docker:build'], function dockerCreateTask(done) {
  var container = docker.getContainer(package.name);
  container.remove({force: true}, function(err, data) {
    docker.createContainer({
      Image: package.name+':'+package.version,
      name: package.name,
      Volumes: gulp_conf.volumes||{},
      ExposedPorts: gulp_conf.ports||{},
      HostConfig: {
        Binds: gulp_conf.binds||[],
        Links: gulp_conf.links||[],
        PortBindings: gulp_conf.pbinds||{}
      }
    }, function(error, container) {
      if(error) return console.log(error);
      container.start(function(error, data) {
        console.log(error);
        console.log(data);
        done();
      });
    });
  });
});

gulp.task('docker:debug', ['docker:build'], function dockerCreateTask(done) {
  var container = docker.getContainer(package.name);
  container.remove({force: true}, function(err, data) {
    docker.createContainer({
      Image: package.name+':'+package.version,
      name: package.name,
      Volumes: gulp_conf.volumes,
      ExposedPorts: gulp_conf.ports||{},
      HostConfig: {
        Binds: gulp_conf.binds||[],
        Links: gulp_conf.links||[],
        PortBindings: gulp_conf.pbinds||{}
      },
      Entrypoint: ["/opt/project/entrypoint.sh", "debug"]
    }, function(error, container) {
      container.attach({
        stream: true,
        stdout: true,
        stderr: true,
        tty: true
      }, function(err, stream) {
        if(err) return;

        stream.pipe(process.stdout);

        container.start(function(error, data) {
          console.log(error);
          if(done) done();
        });
      });
    });
  });
});

gulp.task('debug', ['docker:debug', 'watch'], function serveTask() {
  var portrange = 45032;

  function getPort (cb) {
    var port = portrange;
    portrange += 1;

    var server = net.createServer();
    server.listen(port, function (err) {
      server.once('close', function () {
        cb(port);
      });
      server.close();
    });
    server.on('error', function (err) {
      getPort(cb);
    });
  }

  getPort(function(port) {
    httpProxy.createServer({target: 'http://localhost', ws:true, headers: {'Host': package.name+'__8080__.unc.edu.ar'}}).listen(port);
    console.log("node inspector listening on http://localhost:"+port+'/?port=5858');
  });

});

gulp.task('watch', function(){
  gulp.watch(['index.js', 'v*/**/*.js'], ['docker:debug']);
});

gulp.task('reload', ['docker:debug'], function() {
  browser.reload();
});
