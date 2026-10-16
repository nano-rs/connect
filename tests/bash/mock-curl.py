#!/usr/bin/env python3
"""No sockets: a curl protocol double with persisted credential lifecycle state."""
import json, os, pathlib, sys, hashlib, re
args=sys.argv[1:]
def arg(k): return args[args.index(k)+1]
root=pathlib.Path(os.environ['MOCK_ROOT']); f=root/'state.json'
s=json.loads(f.read_text()) if f.exists() else {'tokens':[], 'calls':[], 'events':[], 'seq':0}
url=args[-1]; path=url.split('/api/',1)[-1]; method=arg('--request')
headers=pathlib.Path(arg('--header')[1:]).read_text()
body=pathlib.Path(arg('--data-binary')[1:]).read_text(); data=json.loads(body) if body else {}
status=200; result={}
sts=['cisco_asa','palo_alto','fortinet','cisco_ios','juniper_srx','sonicwall','pfsense','linux_syslog','f5_bigip','windows_event','windows_sysmon','linux_journald','linux_sysmon','application','routeros']
sources=[dict(source_id='src-'+st,route_key=st,enabled=True) for st in sts if not (os.getenv('MOCK_MISSING')==st and not s.get('published'))]
if os.getenv('MOCK_DISABLED'): sources=[dict(x,enabled=False) for x in sources]
s['calls'].append([method,path])
if os.getenv('MOCK_HTTP_ERROR'): status=int(os.environ['MOCK_HTTP_ERROR'])
elif os.getenv('MOCK_HOSTED') and path=='ingest-tokens': status=404
elif os.getenv('MOCK_HOSTED') and path=='log-sources/ingest-endpoint':
    status=403 if os.getenv('MOCK_HOSTED_DENIED') else 200
    result={'base_url':'https://tenant.ingest.nano.test'}
elif os.getenv('MOCK_HOSTED') and path=='log-sources/ingest-credentials': result={'credentials':json.loads(os.getenv('MOCK_HOSTED_CREDENTIALS','[]')), 'requests':[]}; status=403 if os.getenv('MOCK_METADATA_DENIED') else 200
elif path=='setup/status': result={'initialized':True}
elif path=='ingest-tokens' and method=='GET':
    result={'tokens':s['tokens'],'sources':sources}
    if os.getenv('MOCK_LEGACY'): del result['sources']
elif path=='ingest-tokens' and method=='POST':
    s['seq']+=1; cid='cred-'+str(s['seq']); tok='nit_'+('%08d'%s['seq'])+'-fixture-secret'
    st=data['source_id'].removeprefix('src-')
    cred=dict(credential_id=cid,source_id=data['source_id'],route_key=st,state='active',token_prefix=tok[:12])
    s['tokens'].append(cred); result={'credential':cred,'token':tok};status=201
elif path.startswith('ingest-tokens/') and path.endswith('/revoke') and os.getenv('MOCK_REVOKE_FAIL'): status=503
elif path.startswith('ingest-tokens/'):
    cid=path.split('/')[1]; cred=next(t for t in s['tokens'] if t['credential_id']==cid)
    if path.endswith('/revoke'):
        # Assert state and artifact persisted BEFORE revocation, with replacement id/value.
        states=list(pathlib.Path(os.environ['XDG_CONFIG_HOME']).glob('nano-connect-bash/*/credentials/*/current'))
        assert any(x.read_text().splitlines()[0]!=cid and x.read_text().splitlines()[0].startswith('cred-') for x in states)
        out=os.getenv('NANO_OUT_DIR')
        if out: assert (pathlib.Path(out)/'secrets'/cred['route_key']).read_text() != 'nit_'+('%08d'%int(cid.split('-')[1]))+'-fixture-secret'
        cred['state']='revoked'
    else: cred.update(source_id=data['source_id'],route_key=data['source_id'].removeprefix('src-'),state='active')
elif path=='log-sources': result=[dict(id=x['source_id'],name=x['route_key'],match_values=[x['route_key']],deployed=True) for x in sources]
elif path=='parser-repositories': result=[dict(id='repo-1',name='official',url='https://github.com/nano-rs/parsers',enabled=True)]
elif path.endswith('/parsers'): result=[dict(id='parser-1',name='routeros',file_path='network/router os#?.yaml',raw_content=('category: cloud\ntransports: [api]\n' if os.getenv('MOCK_CLOUD') else 'category: network\ntransports: [syslog]\n')+'match_values:\n  - routeros\n  - mikrotik\n')]
elif '/parsers/import/' in path:
    assert 'router%20os%23%3F.yaml' in path
    result={'log_source_id':'src-routeros'}
elif path.endswith('/publish'): s['published']=True; result={'success':not bool(os.getenv('MOCK_PUBLISH_FAIL'))}
elif path.endswith('/sync/status'): result={'status':'completed','parser_count':42}
elif path.endswith('/sync'): result={}
elif path=='search':
    rows=s['events'] or json.loads(os.getenv('MOCK_RESULTS','[]'))
    if 'metadata.log_source=' in data['query']:
        st, marker=re.fullmatch(r'metadata.log_source="([a-z0-9_-]+)" AND "([A-Za-z0-9_-]+)"',data['query']).groups()
        s['evidence_searches']=s.get('evidence_searches',0)+1
        if os.getenv('MOCK_DELAYED_EVIDENCE') and st=='palo_alto' and s['evidence_searches']==2: rows=[]
        rows=[r for r in rows if marker in json.dumps(r) and r.get('metadata',{}).get('log_source',r.get('metadata.log_source'))==st]
    result={'results':rows,'total_count':len(rows)}
elif path=='auth/login':result={'tokens':{'access_token':'fixture-jwt-secret'}}
elif path=='api-keys':result={'id':'key-1','key':'fixture-api-secret'}
elif '/services/collector/event' in path or '/ingest/' in url:
    assert 'Authorization:' in headers
    if 'event' in data: assert isinstance(data['event'],str), 'HEC event must be original string'
    token=re.search(r'Authorization: (?:Splunk|Bearer) (\S+)',headers).group(1)
    cred=next(t for t in s['tokens'] if t['token_prefix']==token[:12])
    if '/services/collector/event' in path:
        channel=re.search(r'X-Splunk-Request-Channel: ([0-9a-f-]+)',headers).group(1)
        assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',channel)
        old=s.setdefault('channels',{}).setdefault(cred['route_key'],channel)
        assert old==channel, 'HEC channel changed for source'
    # Routing is token-authoritative, even when the payload claims another source.
    s['events'].append({'message':data.get('event',data.get('message')), 'metadata':{'log_source':cred['route_key'], 'ingest_credential_id':cred['credential_id']}})
    result={'text':'Success','code':0}
else: status=404
f.write_text(json.dumps(s))
pathlib.Path(arg('--output')).write_text(json.dumps(result))
print(status,end='')
