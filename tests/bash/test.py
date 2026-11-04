#!/usr/bin/env python3
"""Offline acceptance harness. Never runs installers, services, or real curl/docker."""
import json, os, pathlib, re, shutil, stat, subprocess, tempfile, tomllib
ROOT=pathlib.Path(__file__).resolve().parents[2]
SCRIPT=ROOT/'connect.sh'; BASH=os.getenv('TEST_BASH','bash')
count=0
with tempfile.TemporaryDirectory(prefix='connect-tests-') as td:
    tmp=pathlib.Path(td); bin=tmp/'bin';bin.mkdir(); home=tmp/'home';home.mkdir()
    shutil.copy(ROOT/'tests/bash/mock-curl.py',bin/'curl'); (bin/'curl').chmod(0o755)
    # Any unintended service/installer execution fails; docker only records stub calls.
    for name in ('sudo','systemctl'):
        (bin/name).write_text('#!/bin/sh\nexit 99\n');(bin/name).chmod(0o755)
    (bin/'docker').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_ROOT/docker-calls"\ncase "$*" in *ps*) echo healthy;; esac\n');(bin/'docker').chmod(0o755)
    env=dict(os.environ,PATH=str(bin)+':'+os.environ['PATH'],HOME=str(home),XDG_CONFIG_HOME=str(home/'config'),MOCK_ROOT=td,NANO_URL='https://nano.test',NANO_API_KEY='fixture-api-secret',CONNECT_NO_JQ='1',NANO_NON_INTERACTIVE='1',NANO_TRANSPORT='hec',NANO_OUT_DIR=str(tmp/'out'))
    def run(*args,ok=True,extra=None):
        global count
        e=dict(env);e.update(extra or {})
        p=subprocess.run([BASH,str(SCRIPT),*args],env=e,text=True,capture_output=True)
        assert (p.returncode==0)==ok, (args,p.returncode,p.stdout,p.stderr)
        assert not any(secret in p.stdout+p.stderr for secret in ('-fixture-secret','fixture-api-secret','fixture-jwt-secret','fixture-password-secret'))
        count+=1;return p
    def state():return json.loads((tmp/'state.json').read_text())
    def reset():
        if (tmp/'state.json').exists():(tmp/'state.json').unlink()
        shutil.rmtree(home/'config',ignore_errors=True);shutil.rmtree(tmp/'out',ignore_errors=True)
    def golden(name):
        old=tomllib.loads((ROOT/f'tests/bash/fixtures/ts-{name}.toml').read_text());new=config()
        for key,source in old['sources'].items():
            if key=='journald': source=dict(source,since_now=True)  # 0.5.0: no journal replay on first start
            assert new['sources'][key]==source,(name,key)
        def vrl(text):return re.sub(r'\s+','',re.sub(r'(?m)^\s*#.*$','',text))
        for key,tr in old.get('transforms',{}).items():
            if tr['type']!='remap':continue
            nk='tag' if key=='journald_tag' else key
            assert new['transforms'][nk]['inputs']==tr['inputs'],(name,key)
            if key=='journald_tag':
                # 0.5.0: journald entries go out as `journalctl -o json` for the
                # OCSF journald parser; the TS tagging statements are kept.
                body=vrl(new['transforms'][nk]['source'])
                for stmt in ('source_type="linux_journald"','ifcontains(ident,"sysmon")||contains(unit,"sysmon")','.message=encode_json(entry)','entry.MESSAGE=.message'):
                    assert stmt in body,(name,stmt)
                continue
            assert vrl(new['transforms'][nk]['source'])==vrl(tr['source']),(name,key)
        for sink in new['sinks'].values():
            if sink['type'] in ('http','splunk_hec_logs'):
                assert sink['encoding']['codec']=='text'
                assert sink['buffer']=={'type':'disk','max_size':268435488,'when_full':'block'}
    def validate(label):
        if not os.getenv('VECTOR_VALIDATE') and not os.getenv('VECTOR_BINARY'):return
        image='timberio/vector:0.59.0-alpine@sha256:0e36bc2a290039e9b6a5e92f04bd2f133223506f72d09682c1df16c015172b7a'
        command=([os.environ['VECTOR_BINARY'],'validate','--no-environment',str(tmp/'out/vector.toml')] if os.getenv('VECTOR_BINARY') else ['/usr/bin/docker','run','--rm','--network','none','--read-only','--mount',f'type=bind,src={tmp / "out"},dst=/fixture,readonly',image,'validate','--no-environment','/fixture/vector.toml'])
        p=subprocess.run(command,text=True,capture_output=True)
        assert p.returncode==0,(label,p.stdout,p.stderr)
    def config():return tomllib.loads((tmp/'out/vector.toml').read_text())
    run('--version');run('--help');run('list-sources','--builtin-only');run('verify',ok=False)
    for bad in ('0','65536','-1','hello'):run('add-aggregator','--agent-port',bad,ok=False)
    run('add-source','--sources','cisco_asa:tcp,cisco_asa')
    validate('syslog HEC');c=config();assert len(c['sources'])==2 and c['sources']['cisco_asa']['mode']=='tcp'
    assert c['sinks']['nano_cisco_asa']['encoding']['codec']=='text'
    assert c['sinks']['nano_cisco_asa']['default_token']=='SECRET[nano_ingest.cisco_asa]'
    run('add-source','--sources','cisco_asa');assert state()['seq']==1;golden('syslog')
    run('add-source','--sources','cisco_asa','--rotate');assert state()['seq']==2 and state()['tokens'][0]['state']=='revoked'
    for f in (tmp/'out/secrets').iterdir(): assert stat.S_IMODE(f.stat().st_mode)==0o600
    assert stat.S_IMODE((tmp/'out/secrets').stat().st_mode)==0o700
    run('add-source','--sources','cisco_asa','--transport','http');assert config()['sinks']['nano_cisco_asa']['auth']['strategy']=='bearer';validate('syslog HTTP')
    assert config()['sinks']['nano_cisco_asa']['encoding']['codec']=='text'
    assert config()['sinks']['nano_cisco_asa']['request']['headers']['Content-Type']=='text/plain'
    run('add-source','--sources','cisco_asa','--run');assert 'up -d' in (tmp/'docker-calls').read_text()
    run('add-source','--sources','routeros','--deploy-parsers',extra={'MOCK_MISSING':'routeros'})
    assert state().get('published')
    run('add-agent','--os','linux'); c=config();assert 'journald' in c['sources'];validate('Linux journald');golden('linux')
    run('add-agent','--os','windows'); assert len(config()['sources']['windows_events']['channels'])==6;golden('windows');assert (tmp/'out/install-agent.ps1').exists()
    run('add-agent','--os','linux','--no-journald','--files','/var/log/custom/*.log'); assert 'journald' not in config()['sources'];validate('files only')
    run('add-agent','--os','linux','--target','127.0.0.1:9000'); assert config()['sinks']['out']['address']=='127.0.0.1:9000';validate('native agent')
    run('add-aggregator','--sources','cisco_asa');assert config()['sources']['agents']['address']=='0.0.0.0:9000';validate('aggregator');golden('aggregator')
    run('sync-parsers');run('connect','--source','cisco_asa')
    run('connect','--source','cisco_asa') # same private channel survives another CLI process
    channel_files=list((home/'config').glob('nano-connect-bash/*/channels/cisco_asa'))
    assert len(channel_files)==1 and stat.S_IMODE(channel_files[0].stat().st_mode)==0o600
    run('connect','--source','palo_alto')
    assert state()['channels']['cisco_asa']!=state()['channels']['palo_alto']
    run('connect','--source','cisco_asa','--transport','http')
    run('verify','--source','cisco_asa',extra={'MOCK_RESULTS':'[{"src_ip":"10.0.0.1"}]'})
    evidence=tmp/'evidence.txt'
    evidence.write_text('cisco_asa source-a-request-001\npalo_alto source-b-request-002\n')
    rows=[{'message':'source-a-request-001','metadata':{'log_source':'cisco_asa'}},
          {'message':'source-b-request-002','metadata':{'log_source':'palo_alto'}}]
    s=state();s['events']=rows;(tmp/'state.json').write_text(json.dumps(s))
    run('verify','--evidence-file',str(evidence),'--wait-seconds','0')
    s=state();s['evidence_searches']=0;(tmp/'state.json').write_text(json.dumps(s))
    run('verify','--evidence-file',str(evidence),'--wait-seconds','3',extra={'MOCK_DELAYED_EVIDENCE':'1'})
    assert state()['evidence_searches']==3 # A remembered; only missing B polled again.
    evidence.write_text('cisco_asa source-a-request-001')
    run('verify','--evidence-file',str(evidence),'--wait-seconds','0')
    evidence.write_text('cisco_asa missing-request-marker\n')
    run('verify','--evidence-file',str(evidence),'--wait-seconds','1',ok=False)
    # Different requests for the same source must each be found.
    evidence.write_text('cisco_asa source-a-request-001\ncisco_asa source-a-request-003\n')
    run('verify','--evidence-file',str(evidence),'--wait-seconds','0',ok=False)
    evidence.write_text('palo_alto source-a-request-001\n')
    run('verify','--evidence-file',str(evidence),'--wait-seconds','0',ok=False)
    evidence.write_text('cisco_asa source-a-request-001\npalo_alto source-a-request-001\n')
    run('verify','--evidence-file',str(evidence),'--wait-seconds','0',ok=False)
    run('verify','--evidence-file',str(evidence),'--wait-seconds','121',ok=False)
    # Simulate a claim of B sent with A's token: the server stores it under A.
    token=(tmp/'out/secrets/cisco_asa').read_text()
    headers=tmp/'headers';body=tmp/'body';response=tmp/'response'
    headers.write_text('Authorization: Splunk '+token+'\nX-Splunk-Request-Channel: '+state()['channels']['cisco_asa']+'\n')
    body.write_text(json.dumps({'sourcetype':'palo_alto','event':'authoritative-routing-marker'}))
    subprocess.run([str(bin/'curl'),'--request','POST','--header','@'+str(headers),'--data-binary','@'+str(body),'--output',str(response),'https://nano.test/services/collector/event'],env=env,check=True,capture_output=True)
    assert state()['events'][-1]['metadata']['log_source']=='cisco_asa'
    evidence.write_text('cisco_asa authoritative-routing-marker\n')
    run('verify','--evidence-file',str(evidence),'--wait-seconds','0')
    evidence.write_text('palo_alto authoritative-routing-marker\n')
    run('verify','--evidence-file',str(evidence),'--wait-seconds','0',ok=False)
    # Application parsers on an enabled instance source get an HTTP push listener.
    run('add-source','--sources','apache_access')
    assert config()['sources']['apache_access']['type']=='http_server'
    validate('application HTTP listener')
    assert config()['sources']['apache_access']['decoding']['codec']=='bytes'
    assert config()['sinks']['nano_apache_access']['sourcetype']=='apache_access'
    assert '/http' not in (tmp/'out/docker-compose.yml').read_text()
    run('add-source','--sources','apache_access:tcp');assert config()['sources']['apache_access']['mode']=='tcp'
    run('add-source','--sources','apache_access',extra={'MOCK_DISABLED':'1'},ok=False)
    run('connect','--source','apache_access')

    # 0.5.0 default transport: HTTP through the ingest edge (TLS like the UI).
    reset();run('add-source','--sources','cisco_asa',extra={'NANO_TRANSPORT':''})
    sink=config()['sinks']['nano_cisco_asa'];assert sink['type']=='http' and sink['uri']=='https://nano.test/ingest'
    assert sink['encoding']['codec']=='text' and sink['request']['headers']['Content-Type']=='text/plain'
    # Journald entries leave the agent as `journalctl -o json` objects.
    run('add-agent','--os','linux');assert 'encode_json(entry)' in config()['transforms']['tag']['source']
    # Ingest resolution. Open core, no configured base: the app host.
    def sink_url(name='nano_cisco_asa'):
        sink=config()['sinks'][name];return sink.get('endpoint') or sink.get('uri')
    reset();p=run('add-source','--sources','cisco_asa')
    assert sink_url()=='https://nano.test:18088' and 'Ingest (hec): https://nano.test:18088' in p.stdout
    run('add-source','--sources','cisco_asa','--transport','http');assert sink_url()=='https://nano.test/ingest'
    # Enterprise with a dedicated ingest frontend: never the app host.
    ded={'MOCK_EDITION':'enterprise','MOCK_INGEST_BASE':'https://ingest.nano.test'}
    p=run('add-source','--sources','cisco_asa',extra=ded);assert sink_url()=='https://ingest.nano.test:18088'
    assert 'Dedicated ingest frontend: https://ingest.nano.test' in p.stdout
    run('add-source','--sources','cisco_asa','--transport','http',extra=ded);assert sink_url()=='https://ingest.nano.test/ingest'
    validate('dedicated ingest HTTP')
    s=state();s['ingest_urls']=[];(tmp/'state.json').write_text(json.dumps(s))
    run('connect','--source','cisco_asa',extra=ded);run('connect','--source','cisco_asa','--transport','http',extra=ded)
    assert state()['ingest_urls']==['https://ingest.nano.test:18088/services/collector/event','https://ingest.nano.test/ingest'],state()['ingest_urls']
    for bad in (('--ingest-url','https://nano.test/ingest'),('--ingest-url','http://nano.test:8088'),('--ingest-base','https://nano.test')):
        reset();p=run('connect','--source','cisco_asa','--transport','http',*bad,extra=ded,ok=False)
        assert 'dedicated' in p.stderr and 'app host' in p.stderr
    reset();run('add-source','--sources','cisco_asa',extra={'MOCK_EDITION':'enterprise','MOCK_INGEST_BASE':'https://nano.test'})
    assert sink_url()=='https://nano.test:18088'  # configured base == app origin: not dedicated
    # Enterprise, no configured base: app host with a warning.
    reset();p=run('add-source','--sources','cisco_asa','--transport','http',extra={'MOCK_EDITION':'enterprise'})
    assert sink_url()=='https://nano.test/ingest' and 'no dedicated ingest base' in p.stdout
    # Enterprise, endpoint unreadable: explicit base required, then saved per instance.
    unreadable={'MOCK_EDITION':'enterprise','MOCK_ENDPOINT_STATUS':'403'}
    reset();p=run('add-source','--sources','cisco_asa',extra=unreadable,ok=False);assert '--ingest-base' in p.stderr
    run('add-source','--sources','cisco_asa','--ingest-base','https://ingest.byoc.test',extra=unreadable);assert sink_url()=='https://ingest.byoc.test:8088'
    run('add-source','--sources','cisco_asa','--transport','http',extra=unreadable);assert sink_url()=='https://ingest.byoc.test/ingest'
    run('add-source','--sources','cisco_asa','--ingest-base','https://ingest.byoc.test/path',ok=False)
    # Open edition with the endpoint unreadable falls back to the app host.
    reset();run('add-source','--sources','cisco_asa','--transport','http',extra={'MOCK_ENDPOINT_STATUS':'403'});assert sink_url()=='https://nano.test/ingest'
    reset();run('add-source','--sources','cisco_asa',extra={'MOCK_ENDPOINT_STATUS':'500'},ok=False)
    # Explicit per-transport URL (Civo/BYOC load balancer) wins over discovery.
    reset();run('add-source','--sources','cisco_asa','--ingest-url','https://hec.civo.test',extra=ded);assert sink_url()=='https://hec.civo.test'
    # Base with the discovered HEC port on the chosen host.
    reset();run('add-source','--sources','cisco_asa','--ingest-base','https://ingest2.nano.test',extra=ded);assert sink_url()=='https://ingest2.nano.test:18088'
    reset();p=run('otlp-config','--source','cisco_asa',extra=ded)
    assert 'OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.nano.test/otlp\n' in (tmp/'out/otel.env').read_text()
    run('otlp-config','--source','cisco_asa','--ingest-url','https://otlp.nano.test/otlp',extra=ded)
    assert 'OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nano.test/otlp\n' in (tmp/'out/otel.env').read_text()
    run('add-source','--sources','cisco_asa','--transport','http',extra=ded);assert sink_url()=='https://ingest.nano.test/ingest'  # OTLP URL not reused
    # No token delivery on the deployment: nothing is issued.
    reset();p=run('add-source','--sources','cisco_asa',extra={'MOCK_DELIVERY':'none'},ok=False);assert 'NANO_INGEST_TOKENS_DELIVERY' in p.stderr
    assert not any(m=='POST' and x=='ingest-tokens' for m,x in state()['calls'])
    # Lake-only paths are gone.
    for args in (('--token-file','/dev/null'),('--credential-id','x')):
        p=run('add-source','--sources','cisco_asa',*args,ok=False);assert 'removed in 0.5.0' in p.stderr
    run('add-source','--sources','cisco_asa',extra={'NANO_TOKEN_FILE':'/dev/null'},ok=False)
    assert not any('ingest-credentials' in x for _,x in state()['calls'])
    # revoke-token revokes the token connect issued for the source.
    reset();run('add-source','--sources','cisco_asa');run('revoke-token','--source','cisco_asa')
    assert [t['state'] for t in state()['tokens']]==['revoked']
    run('revoke-token','--source','cisco_asa',ok=False)
    reset()

    run('add-source','--sources','x"\n[sinks.evil]',ok=False)
    run('add-source','--transport','native',ok=False)
    run('add-source','--ingest-token','fixture-secret',ok=False)
    run('add-source','--url','https://user:pass@nano.test',ok=False)
    run('add-source','--url','https://other.test','--sources','cisco_asa',extra={'NANO_API_KEY':''},ok=False)
    run('add-source','--sources','cisco_asa',extra={'MOCK_LEGACY':'1'},ok=False)
    run('add-source','--sources','cisco_asa',extra={'MOCK_DISABLED':'1'},ok=False)
    for code in ('401','403','500'):run('add-source','--sources','cisco_asa',extra={'MOCK_HTTP_ERROR':code},ok=False)
    reset();run('add-source','--sources','cisco_asa',extra={'CONNECT_NO_JQ':'0'})
    reset();run('add-source','--sources','palo_alto',extra={'NANO_API_KEY':'','NANO_EMAIL':'admin@nano.test','NANO_PASSWORD':'fixture-password-secret'},ok=False)
    reset();run('add-source','--sources','cisco_asa','--yes',extra={'NANO_API_KEY':'','NANO_EMAIL':'admin@nano.test','NANO_PASSWORD':'fixture-password-secret'})
    # Known prefixes allow supplied active/unbound credential inspection.
    run('add-source','--sources','cisco_asa')
    supplied=tmp/'supplied';supplied.mkdir()
    token=(tmp/'out/secrets/cisco_asa').read_text();(supplied/'cisco_asa').write_text(token)
    run('add-source','--sources','cisco_asa','--token-dir',str(supplied))
    (supplied/'palo_alto').write_text(token)
    run('add-source','--sources','palo_alto','--token-dir',str(supplied),ok=False)
    run('add-source','--sources','cisco_asa','--token-dir',str(supplied),'--rotate',ok=False)
    s=state();s['tokens'][0].update(state='unbound',source_id=None,route_key=None);(tmp/'state.json').write_text(json.dumps(s))
    run('add-source','--sources','cisco_asa','--token-dir',str(supplied));assert state()['tokens'][0]['state']=='active'
    s=state();s['tokens'][0]['state']='revoked';(tmp/'state.json').write_text(json.dumps(s))
    run('add-source','--sources','cisco_asa','--token-dir',str(supplied),ok=False)
    run('add-source','--sources','mikrotik');assert 'routeros' in config()['sources']
    run('add-agent','--os','linux','--target','[::1]:9000');assert config()['sinks']['out']['address']=='[::1]:9000'
    run('add-agent','--os','linux','--target','host:65536',ok=False)
    run('add-agent','--os','linux','--no-journald',ok=False)
    run('add-source','--sources','cisco_asa:tls',ok=False)
    run('add-source','--sources','cisco_asa','--out-dir',str(tmp/'loose'))
    (tmp/'loose/secrets/cisco_asa').chmod(0o644)
    run('add-source','--sources','cisco_asa','--out-dir',str(tmp/'loose'));assert stat.S_IMODE((tmp/'loose/secrets/cisco_asa').stat().st_mode)==0o600
    run('otlp-config','--source','cisco_asa')
    assert stat.S_IMODE((tmp/'out/otel.env').stat().st_mode)==0o600
    assert 'Authorization=Bearer nit_' in (tmp/'out/otel.env').read_text()
    run('rotate-token','--source','cisco_asa')
    run('rotate-token','--source','cisco_asa',extra={'MOCK_REVOKE_FAIL':'1'},ok=False)
    pending=list((home/'config').glob('nano-connect-bash/*/credentials/cisco_asa/pending-revoke'))
    assert len(pending)==1 and len([t for t in state()['tokens'] if t['route_key']=='cisco_asa' and t['state']=='active'])==2
    run('add-source','--sources','cisco_asa')
    assert not pending[0].exists() and len([t for t in state()['tokens'] if t['route_key']=='cisco_asa' and t['state']=='active'])==1
    run('add-source','--sources','routeros',extra={'MOCK_CLOUD':'1'})
    assert config()['sources']['routeros']['type']=='http_server'
    run('add-source','--sources','routeros',extra={'MOCK_CLOUD':'1','MOCK_DISABLED':'1'},ok=False)
    run('add-agent','--os','linux','--no-journald','--files','/var/log/a.log,/var/log/b.log')
    assert config()['sources']['files']['include']==['/var/log/a.log','/var/log/b.log']
    validate('multiple file paths')
    s=state();s['events']=[];(tmp/'state.json').write_text(json.dumps(s))
    for rows,expected in [([{'src_ip':'10.0.0.1'}],'1 normalized'),([{'metadata':{'parser_type':'generic'}}],'1 generic'),([{'ext.parse_error':'format mismatch'}],'1 parser failures')]:
        p=run('verify','--source','cisco_asa',extra={'MOCK_RESULTS':json.dumps(rows)})
        assert expected in p.stdout
    run('verify','--source','cisco_asa',ok=False)
    run('add-source','--sources',' CISCO_ASA:TCP , cisco_asa ')
    assert config()['sources']['cisco_asa']['mode']=='tcp'
    run('rotate-token','--source','cisco_asa',extra={'MOCK_REVOKE_FAIL':'1'},ok=False)
    run('rotate-token','--source','cisco_asa')
    assert len([t for t in state()['tokens'] if t['route_key']=='cisco_asa' and t['state']=='active'])==1
print(f'PASS: {count} offline CLI checks ({BASH})')
