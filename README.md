# virtualhost

Reverse HTTP Proxy for Swarm mode

### Description:

Reverse HTTP Proxy for Swarm mode that works with websockets, even in polling mode (sticky session).

Inspired by Bouncy, it works with streams, and scales to use as many cores as are available.

### How to use:

1. Create a network named virtualhost

    ```bash
    docker network create -d overlay virtualhost
    ```

2. Create virtualhost service (could be global or not, but if not, make sure it runs in manager)

    ```bash
    docker service create
    	  --name virtualhost 
        --env REDIS=myRedisService
        --network virtualhost
        --mode global
        --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock
        --publish 80:80
        cendra/virtualhost
   ```

1. Create your service and configure it to be used by virtualhost

    ```
    docker service create
    	  --name myService
        --network virtualhost
        --label vhnames=myservice.com,http://mysite.com/myservice,http://debug.myservice.com:8080
        --replicas 3
        mysite/myservice:1.0.0
    ```

#### There are three requirements to use virtualhost:

1. Your service should be attached to *virtualhost* network

2. You should declare at least one alias with vhnames label

3. A redis service should be accesible to virtualhost container, and configured through REDIS environment variable.

#### Lables declared in vhnames follow this rules

1. You can specify the protocol to be http, https or you can not specify a protocol at all. This doesn't specify the protocol your service is talking, but really tells virtualhost which port this alias should be served from.

2. You can specify different names and paths for the aliases. If you specify an alias path, when the request arrives the former will be trimmed from the request path.

    For example, in the alias you specified ```/myservice``` as path, and in the request arrives ```/myservice/image/1.png```, to the service it will only be proxied ```/image/1.png```.

3. You can specify different ports for different aliases. If your docker is listening in more than one port, for example, your debugger is listening in port 8080, you can specify it to an alias.

     In the example above, for every request that arrives in port 80 in virtualhost to the host *debug.myservice.com* will be proxied to port 8080 of the service.

#### Websockets in polling mode (sticky session)

If you need sticky sessions, you should add the label ```--label vhlb=true``` in your service definition. That's it.

### HTTPS:

If you want to publish services through HTTPS, you should run this steps before step 1

1. Create this secrets
    ```
    docker secret create vh_key keyfile

    docker secret create vh_cert certfile
    ```

2. Replace step 2 whith this
   ```bash
    docker service create
    	  --name virtualhost
        --env REDIS=myRedisService
        --network virtualhost
        --mode global
        --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock
        --secret source=vh_key,target=key
        --secret source=vh_cert,target=cert
        --publish 80:80
        --publish 443:443
        cendra/virtualhost
   ```

Now, when you specify an alias with *https*, it will be served from 443 port.

### Issues and Contributions

* https://github.com/cendra/docker-virtualhost
