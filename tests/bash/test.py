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
    env=dict(os.environ,PATH=str(bin)+':'+os.environ['PATH'],HOME=str(home),XDG_CONFIG_HOME=str(home/'config'),MOCK_ROOT=td,NANO_URL='https://nano.test',NANO_API_KEY='fixture-api-secret',CONNECT_NO_JQ='1',NANO_NON_INTERACTIVE='1',NANO_OUT_DIR=str(tmp/'out'))
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
            assert new['sources'][key]==source,(name,key)
        def vrl(text):return re.sub(r'\s+','',re.sub(r'(?m)^\s*#.*$','',text))
        for key,tr in old.get('transforms',{}).items():
            if tr['type']!='remap':continue
            nk='tag' if key=='journald_tag' else key
            assert new['transforms'][nk]['inputs']==tr['inputs'],(name,key)
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
    p=run('add-source','--sources','cisco_asa',extra={'MOCK_HOSTED':'1'},ok=False)
    assert 'Settings' in p.stderr and '--token-file' in p.stderr
    assert ['GET','log-sources/ingest-credentials'] in state()['calls']
    p=run('add-source','--sources','cisco_asa',extra={'MOCK_HOSTED':'1','MOCK_HOSTED_DENIED':'1'},ok=False)
    assert 'log_sources:view' in p.stderr

    hosted_token=tmp/'hosted-token';hosted_token.write_text(token)
    hosted={'MOCK_HOSTED':'1'}
    run('add-source','--sources','cisco_asa','--token-file',str(hosted_token),extra=hosted)
    assert stat.S_IMODE(next((home/'config').glob('nano-connect-bash/*/credentials/cisco_asa/hosted-token')).stat().st_mode)==0o600
    run('connect','--source','cisco_asa','--token-file',str(hosted_token),extra=hosted)
    run('connect','--source','cisco_asa','--transport','http',extra=hosted)
    run('add-source','--sources','cisco_asa','--transport','http','--token-file',str(hosted_token),extra=hosted)
    sink=config()['sinks']['nano_cisco_asa']
    assert sink['encoding']['codec']=='json', 'Hosted HTTPS ingest requires JSON; raw text is rejected'
    assert sink['request']['headers']['Content-Type']=='application/json'
    assert sink['framing']['method']=='newline_delimited'
    assert sink['auth']['token']=='SECRET[nano_ingest.cisco_asa]'
    validate('hosted syslog HTTPS JSON')
    run('add-source','--sources','cisco_asa',extra=dict(hosted,MOCK_METADATA_DENIED='1'))
    metadata={'credential_id':'hosted-1','kind':'source','state':'active','protocol':'hec','source_slugs':['cisco_asa']}
    hm=dict(hosted,MOCK_HOSTED_CREDENTIALS=json.dumps([metadata]))
    run('add-source','--sources','cisco_asa','--credential-id','hosted-1',extra=hm)
    for key,value in [('state','revoked'),('kind','collector'),('protocol','nano_https'),('source_slugs',['palo_alto'])]:
        run('add-source','--sources','cisco_asa','--credential-id','hosted-1',extra=dict(hosted,MOCK_HOSTED_CREDENTIALS=json.dumps([dict(metadata,**{key:value})])),ok=False)
    run('add-source','--sources','cisco_asa','--credential-id','unknown',extra=hm,ok=False)
    run('add-source','--sources','cisco_asa,palo_alto','--token-file',str(hosted_token),extra=hosted,ok=False)
    for args in [('rotate-token','--source','cisco_asa','--out-dir',str(tmp/'out')),('revoke-token','--source','cisco_asa'),('add-source','--sources','cisco_asa','--rotate')]:
        p=run(*args,extra=hosted,ok=False);assert 'Settings' in p.stderr
    assert not any(method=='POST' and path.startswith('log-sources/ingest-credentials') for method,path in state()['calls'])

    # Hosted real-world rows use source_type=routed with the slug in name.
    apache_token=tmp/'apache-token'
    run('add-source','--sources','apache_access')
    apache_token.write_text((tmp/'out/secrets/apache_access').read_text())
    assert config()['sources']['apache_access']['type']=='http_server'
    validate('application HTTP listener')
    assert config()['sources']['apache_access']['decoding']['codec']=='bytes'
    assert config()['sinks']['nano_apache_access']['sourcetype']=='apache_access'
    assert '/http' not in (tmp/'out/docker-compose.yml').read_text()
    run('add-source','--sources','apache_access','--token-file',str(apache_token),extra=hosted)
    run('connect','--source','apache_access','--token-file',str(apache_token),extra=hosted)
    run('add-source','--sources','apache_access:tcp','--token-file',str(apache_token),extra=hosted)
    assert config()['sources']['apache_access']['mode']=='tcp'
    run('add-source','--sources','apache_access','--token-file',str(apache_token),extra=dict(hosted,MOCK_DISABLED='1'),ok=False)
    supplied_hosted=tmp/'hosted-tokens';supplied_hosted.mkdir()
    (supplied_hosted/'apache_access').write_text(apache_token.read_text())
    (supplied_hosted/'cisco_asa').write_text(hosted_token.read_text())
    denied=dict(hosted,MOCK_HOSTED_DENIED='1')
    for token_args in [('--token-file',str(apache_token)),('--token-dir',str(supplied_hosted))]:
        p=run('add-source','--sources','apache_access',*token_args,'--ingest-url','https://tenant.ingest.nano.test',extra=denied)
        assert 'discovery forbidden' in p.stdout.lower() and 'unverified' in p.stdout
        assert config()['sources']['apache_access']['type']=='http_server'
        run('connect','--source','apache_access',*token_args,'--ingest-url','https://tenant.ingest.nano.test',extra=denied)
        run('connect','--source','apache_access',*token_args,extra=denied,ok=False) # cached URL is insufficient
    run('connect','--source','apache_access','--token-file',str(apache_token),'--ingest-url','https://tenant.ingest.nano.test',extra=dict(denied,MOCK_TOKEN_STATUS='403'))
    run('connect','--source','apache_access',extra=dict(denied,NANO_TOKEN_FILE=str(apache_token),NANO_INGEST_URL='https://tenant.ingest.nano.test'))
    for status in ('401','404','500'):
        run('connect','--source','apache_access','--token-file',str(apache_token),'--ingest-url','https://tenant.ingest.nano.test',extra=dict(denied,MOCK_ENDPOINT_STATUS=status),ok=False)
    run('add-source','--sources','apache_access,cisco_asa','--token-dir',str(supplied_hosted),'--ingest-url','https://tenant.ingest.nano.test',extra=denied)
    assert set(config()['sinks']) >= {'nano_apache_access','nano_cisco_asa'}
    run('connect','--source','apache_access','--ingest-url','https://tenant.ingest.nano.test',extra=denied,ok=False)
    run('connect','--source','palo_alto','--token-dir',str(supplied_hosted),'--ingest-url','https://tenant.ingest.nano.test',extra=denied,ok=False)
    run('add-source','--sources','apache_access','--token-file',str(apache_token),'--ingest-url','https://tenant.ingest.nano.test','--rotate',extra=denied,ok=False)
    assert apache_token.read_text()==(supplied_hosted/'apache_access').read_text()
    assert not any(method=='POST' and path.startswith('log-sources/ingest-credentials') for method,path in state()['calls'])

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
    run('otlp-config','--source','cisco_asa',ok=False)
    run('otlp-config','--source','cisco_asa',extra={'NANO_OTLP_SOURCE_AUTH_RELEASED':'1'})
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
