# Slamtec S2E Tracker

Slamtec RPLIDAR **S2E**를 벽에 설치해 손이 스캔 평면을 통과하는 위치를 감지하고, 터치 시작·이동·종료와 영역 정보를 **OSC/UDP로 Unity에 전달**하는 Electron 데스크톱 앱입니다. 3대의 프로젝터를 블렌딩한 `5760×1200` 벽면 같은 설치형 인터랙티브 작업이 주 용도입니다. 바닥 사람 추적도 **Person tracking** 프로필과 기존 **slots** OSC 모드로 계속 지원합니다.

주요 기능:

- S2E Ethernet LiDAR 스캔 수신 및 실시간 point cloud 표시
- 배경 학습 기반 foreground 분리
- 스캔 각도·거리 마스크, gap 기반 클러스터링과 다중 손/사람 ID 트래킹
- 4점 캘리브레이션으로 LiDAR mm 좌표를 normalized `[0, 1]` 좌표로 변환
- Wall view에서 그리는 다각형 터치 영역과 영역별 좌표 출력
- Unity용 터치 수명주기 OSC 출력, TouchDesigner용 고정 slot 출력
- 외부 OSC 패키지 없이 사용하는 [Unity 수신기](unity/WallTouch/README.md)
- 설치 상태·배경 기준 자동 저장/복원 및 preset 저장/불러오기

## 지원 환경

- macOS
- Windows x64
- Node.js 20 이상 권장
- Slamtec RPLIDAR S2E
- S2E용 12V 전원 어댑터
- 컴퓨터와 S2E를 연결할 Ethernet 또는 USB-LAN 어댑터

플랫폼별 빌드 도구:

- macOS: Xcode Command Line Tools 또는 `make`/C++ compiler
- Windows x64: Visual Studio 2022 Build Tools, **Desktop development with C++** workload, Git

Slamtec SDK는 저장소에 포함하지 않습니다. `npm run bridge:setup`이 공식 SDK를 `bridge/third_party/` 아래로 내려받고 로컬에서 빌드합니다.

## 빠른 시작

```bash
git clone https://github.com/0dot77/slamtec-s2e-tracker.git
cd slamtec-s2e-tracker
npm install
npm run bridge:setup
npm run dev
```

`npm run bridge:setup`은 최초 1회만 필요합니다. SDK나 bridge를 다시 빌드해야 할 때는 `npm run bridge`를 실행합니다.

## 하드웨어 연결

S2E 기본 주소는 `192.168.11.2:8089`입니다. 앱도 이 값을 기본값으로 사용합니다.

1. S2E에 12V 전원을 연결합니다.
2. S2E Ethernet을 컴퓨터의 Ethernet/USB-LAN 어댑터에 연결합니다.
3. 해당 네트워크 인터페이스를 수동 IP로 설정합니다.

macOS:

```bash
networksetup -setmanual "USB 10/100/1000 LAN" 192.168.11.100 255.255.255.0
```

인터페이스 이름은 Mac 환경마다 다릅니다. 현재 서비스 이름은 다음 명령으로 확인할 수 있습니다.

```bash
networksetup -listallnetworkservices
```

Windows:

```powershell
Get-NetAdapter
New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.11.100 -PrefixLength 24
```

이미 같은 인터페이스에 IP가 잡혀 있다면 Windows 설정 앱에서 IPv4를 수동으로 바꿔도 됩니다.

S2E는 ICMP ping에 응답하지 않을 수 있습니다. `ping 192.168.11.2` 실패만으로 연결 실패라고 판단하지 말고 ARP를 확인하세요.

macOS:

```bash
arp -an | grep 192.168.11.2
```

Windows:

```powershell
arp -a | findstr 192.168.11.2
```

MAC 주소가 보이면 물리 연결과 IP 대역 설정은 대체로 정상입니다.

## 앱 사용 순서

1. `npm run dev`로 앱을 실행합니다.
2. **Start**를 눌러 S2E bridge를 시작합니다.
3. LiDAR point cloud가 보이는지 확인합니다.
4. **Wall touch** 프로필을 사용하고, 벽 주변을 비운 상태에서 **Learn background**를 누릅니다.
5. **Calibrate**에서 투사 영역의 **왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래**를 차례로 손으로 짚어 각 점을 캡처합니다.
6. **Wall view**에서 **+ Draw zone**으로 터치할 다각형 영역을 그리고 터치 영역으로 활성화합니다.
   - 클릭: 점 추가
   - 첫 점 근처 클릭, double click, 또는 Enter: zone 완료
   - Esc: 작성 취소
   - vertex drag: zone 모양 수정
7. [Unity 설치 순서](unity/WallTouch/README.md)에 따라 `WallTouchReceiver`를 추가하고 UDP `7000`을 받습니다. Ready 상태에서 터치를 확인합니다.
8. 설치 상태는 자동 저장됩니다. 다른 설치로 옮기거나 별도로 보관하려면 preset을 저장합니다.

캘리브레이션 전에도 point cloud와 기본 트래킹은 볼 수 있지만, 기본 설정에서는 Ready가 될 때까지 터치 출력을 보류합니다. Zone polygon은 normalized 공간에 저장되므로 센서 위치가 바뀌면 배경 학습과 캘리브레이션을 다시 진행하세요. 바닥 설치는 **Person tracking** 프로필을 선택하고, TouchDesigner에서는 OSC **slots** 모드를 사용합니다.

## 벽 터치 설치 가이드

1. **센서 설치:** 스캔 평면을 벽과 평행하게 맞추고 표면에서 **2–5 cm** 앞에 둡니다. 센서 스캔 평면의 평탄도 허용 오차와 벽의 굴곡 때문에 한 지점만 보고 맞추면 안 됩니다. 투사 영역의 가까운 곳·중앙·먼 곳과 여러 모서리에서 간격을 확인해 평면이 벽에 닿거나 손을 놓치는 곳이 없는지 점검합니다. 센서는 모서리 또는 가장자리에, 가능하면 투사 영역 밖에 고정합니다.
2. **스캔 마스크:** LiDAR view에서 벽의 유효 방향을 확인하고 `angleMinDeg`/`angleMaxDeg`와 `rangeMinMm`/`rangeMaxMm`으로 각도 부채꼴과 거리 범위를 제한합니다. 센서 각도 기준이며 화면의 위쪽 방향과 같다고 가정하지 마세요. 최소 각도가 최대 각도보다 크면 0°를 가로질러 연결됩니다. 기본 `0–360°`는 전체 방향입니다. 센서 마운트·옆 벽·관객 통로를 제외하되 네 캘리브레이션 모서리는 포함합니다.
3. **배경 학습:** 아무도 벽 근처에 서 있거나 손·팔을 내밀지 않은 상태에서 **Learn background**를 실행하고 완료될 때까지 기다립니다. 기본 50 frame은 약 10 Hz에서 약 5초입니다. 벽·설치물·센서 위치가 달라지면 다시 학습합니다. 각도·거리·품질 마스크를 크게 바꾼 뒤에도 빈 벽에서 다시 학습하고 Ready 상태를 확인합니다.
4. **4점 캘리브레이션:** 블렌딩과 투사 위치를 먼저 확정합니다. **Calibrate**에서 한 번에 한 손으로 투사 영역의 **TL(왼쪽 위), TR(오른쪽 위), BR(오른쪽 아래), BL(왼쪽 아래)**를 짚고 해당 손 클러스터를 캡처합니다. 이 순서가 `(0,0), (1,0), (1,1), (0,1)`에 대응합니다. 손을 치우고 다음 모서리를 짚어 다른 물체가 선택되지 않게 합니다. 캘리브레이션 중에는 터치 출력을 보류합니다. 교차하거나 거의 일직선인 네 점은 유효하지 않으므로 다시 캡처합니다.
5. **터치 영역 작성:** **Wall view**에서 투사 화면에 맞춰 다각형 zone을 그리고 `enabled`와 `touch`를 켭니다. 활성 터치 영역이 하나 이상이면 그 안의 터치만 전달하며 영역 이름을 붙입니다. 활성 터치 영역이 없으면 캘리브레이션된 화면 전체를 받으며 이름은 빈 문자열입니다. `touch=false`인 zone은 터치 허용 영역에 포함되지 않습니다. 영역을 벗어난 손이 다시 들어오면 새 터치 ID가 발급됩니다.
6. **현장 확인:** Unity debug overlay로 네 모서리와 중앙, 먼 쪽 영역, 동시 터치, 영역 밖 이동과 재진입을 확인합니다. 아래 기본값에서 필요한 항목만 조정하고 다시 검사합니다.

모든 거리 값은 mm입니다. 아래는 `src/shared/types.ts`의 **Wall touch** 프로필에 정의된 전체 `PipelineConfig`입니다.

| 필드 | 의미 | 벽 터치 기본값 | 변경할 때 |
| --- | --- | --- | --- |
| `bgDeltaMm` | 배경 기준 거리보다 센서 쪽에 있어야 하는 최소 차이 | `40` mm | 작은 손이 빠지면 낮추고, 벽 잡음이 터치로 잡히면 높임 |
| `bgNoiseK` | 각도 bin의 robust sigma 배수. 전경 문턱은 `max(bgDeltaMm, bgNoiseK × sigma)` | `4` | 흔들리는 배경의 오검출을 줄이려면 높임; 낮추면 작은 변화에 민감 |
| `bgMinReturnRatio` | 학습 frame 중 이 비율 미만으로 반사된 bin은 빈 공간으로 취급; 새 반사는 전경 | `0.5` | 드문 배경 반사 때문에 손을 놓치거나 빈 공간이 잘못 학습될 때 |
| `bgLearnFrames` | 배경 학습 frame 수 | `50` | 배경 잡음이 크면 늘림; 약 10 Hz에서 50 frame ≈ 5초 |
| `clusterGapMm` | 인접 스캔 점을 같은 클러스터로 연결하는 거리 문턱 | `40` mm | 먼 손이 쪼개지면 늘리고, 인접 손이 합쳐지면 줄임 |
| `minClusterPts` | 클러스터의 최소 점 수 | `2` | 먼 손을 놓치면 낮춤; 단발 잡음이 많으면 높임 |
| `minSizeMm` | 클러스터 bounding box 대각선의 최소 길이 | `10` mm | 작은 손가락을 놓치면 낮추고, 작은 잡음을 제외하려면 높임 |
| `maxSizeMm` | 클러스터 bounding box 대각선의 최대 길이 | `250` mm | 손·팔이 합쳐져 제외되면 늘림; 큰 몸체를 걸러내려면 줄임 |
| `trackMaxJumpMm` | 예측 위치 주위의 동일 트랙 연결 허용 거리 | `200` mm | 빠른 손이 새 ID로 바뀌면 늘림; 가까운 손의 ID가 뒤바뀌면 줄임 |
| `smoothing` | 위치 평활 계수; `1`은 원시 위치, 작을수록 강한 평활 | `0.85` | 떨림이 크면 낮춤; 이동 반응 지연이 크면 높임 |
| `birthFrames` | 새 트랙 확정에 필요한 검출 frame 수 | `1` | 단발 오검출이 많으면 늘림; 짧은 탭을 받으려면 낮게 유지 |
| `deathFrames` | 연속 미검출이 이 frame 수에 도달하면 트랙 종료 | `2` | 터치가 자주 끊기면 늘림; 손을 뗀 후 오래 남으면 줄임 |
| `angleMinDeg` | 스캔 마스크의 시작 센서 각도 | `0`° | 벽 유효 방향만 남기도록 설정; 최소 > 최대이면 0°를 가로지름 |
| `angleMaxDeg` | 스캔 마스크의 끝 센서 각도 | `360`° | 마운트·옆 벽·관객 방향을 제외할 때 |
| `rangeMinMm` | 스캔 마스크의 최소 센서 거리 | `100` mm | 마운트 근처 반사를 제거하거나 센서 가까운 터치를 포함할 때 |
| `rangeMaxMm` | 스캔 마스크의 최대 센서 거리 | `10000` mm | 먼 투사 모서리를 포함하거나 화면 뒤쪽 반사를 제외할 때 |
| `minQuality` | 통과할 최소 반사 품질, `0–255` | `0` | 낮은 품질의 잡음이 많으면 높임; 먼 손·약한 반사가 빠지면 낮춤 |
| `roiMargin` | 캘리브레이션 바깥 점을 클러스터링 전에 제거하는 normalized 여유 폭; `[-margin, 1+margin]` | `0.02` | 가장자리 클러스터가 잘리면 늘림; 화면 밖 물체가 섞이면 줄임. 터치 영역 자체가 넓어지지는 않음 |

Ready는 보정·배경·스캔 상태를 함께 판단합니다. `requireReady=true`(기본값)이면 준비 전에는 begin/move를 보내지 않습니다. `/frame`의 ready는 준비 여부 `1/0`이며 상세 원인은 앱의 `readyReason`으로 확인합니다.

| `ReadyReason` | 의미 / 조치 |
| --- | --- |
| `ok` | 유효한 캘리브레이션과 배경 기준이 있고 스캔이 최신임 |
| `no-calibration` | 네 모서리 캘리브레이션이 없음; 캘리브레이션 실행 |
| `bad-calibration` | 네 점 또는 homography가 유효하지 않음; 순서와 점 위치를 다시 확인 |
| `learning` | 배경 학습 중; 벽을 비우고 완료까지 대기 |
| `no-background` | 완료된 배경 기준이 없음; Learn background 실행 |
| `calibrating` | 모서리 캡처 중; 캘리브레이션 완료 후 확인 |
| `stalled` | 센서 스캔이 끊김; 전원·Ethernet·연결 상태 확인 |

## OSC 출력

기본 목적지는 `127.0.0.1:7000`, prefix는 **`/wall`**, mode는 **`touch`**입니다. 다른 PC의 Unity로 보낼 때는 host를 수신 PC의 IP로 설정합니다. `mode`는 `touch`, `slots`, `both`를 지원하고 `both`는 두 스트림을 함께 보냅니다. 아래 `<prefix>`는 설정한 prefix입니다.

**touch 모드 (Unity)**

| Address | OSC type tag | 인자 / 의미 |
| --- | --- | --- |
| `<prefix>/touch` | `,iiffs` | `id, phase, x, y, zone` — `phase`: `0` begin, `1` move, `2` end, `3` cancel |
| `<prefix>/zone/<zone>/touch` | `,iiff` | `id, phase, lx, ly` — 해당 터치 영역 bounding box 내부의 normalized 좌표 |
| `<prefix>/frame` | `,iiii` | `session, seq, count, ready` — frame 이후 활성 터치 수와 준비 여부 `1/0` |
| `<prefix>/alive` | `,i…` 또는 `,` | 모든 활성 터치 ID. 터치가 없으면 인자도 없음 |

약 10 Hz의 매 scan frame마다 즉시 timetag인 OSC bundle을 하나 이상 보내며, bundle 하나는 약 1200 byte 이하입니다. 순서는 전역 touch 메시지 → zone-touch 메시지 → 마지막 bundle의 `/frame`, `/alive`입니다. 여러 bundle을 모은 뒤 `/frame`으로 세션을 확인하고 이벤트를 전달하는 수신기가 포함되어 있습니다. OSC 인코딩은 [OSC 1.0 명세](https://opensoundcontrol.stanford.edu/spec-1_0.html)를 따릅니다.

ID는 세션 내에서 증가하며 재사용하지 않습니다. 터치 영역 밖으로 나갔다 다시 들어오면 새 ID를 받습니다. `session`은 양의 int32 난수이며 앱 시작 및 센서 연결/재연결 때 바뀝니다. `seq`는 세션 내 frame 순서 번호입니다. 세션이 달라지면 수신기는 기존 터치를 모두 종료합니다. `/alive` 목록에서 사라진 ID도 종료해 UDP 종료 패킷 손실을 복구합니다. 알 수 없는 ID의 move는 begin을 합성하고, 알 수 없는 end는 무시합니다.

스캔이 **300 ms** 멈추면 송신기는 활성 터치를 cancel하고, ready=`0`인 `/frame`을 **500 ms**마다 heartbeat로 보냅니다. 수신기는 `/frame`이 **1초** 넘게 오지 않으면 모든 터치를 종료해야 합니다. Unity 수신기의 `Connected`는 최근 `/frame` 수신 여부이고 `Ready`는 frame의 준비 상태이므로, 센서가 멈춰도 heartbeat가 도착하면 Connected=true, Ready=false일 수 있습니다.

영역 이름은 공백, C0 제어 문자(`U+0000–U+001F`), DEL(`U+007F`)과 `# * , / ? [ ] { }`의 연속을 `_`로 바꾸고 양끝 `_`를 제거합니다. 결과가 비면 `zone`을 사용합니다. 정리한 이름이 중복되면 zone 목록 순서대로 `_2`, `_3`, …을 붙입니다. Unity의 zone filter에는 이 **OSC 이름**을 입력합니다. 활성 터치 영역이 없으면 `/touch`의 zone은 `""`이고 별도 zone-touch 메시지는 없습니다.

앱의 normalized 벽 좌표는 `u=0→1`이 왼쪽→오른쪽, `v=0→1`이 위→아래입니다. 기본 `yUp=true`에서는 OSC의 `x=u`, `y=1-v`이므로 Unity의 왼쪽 아래 원점에 맞습니다. `yUp=false`이면 `y=v`이며 수신기의 `senderYUp=false`도 함께 설정합니다. 전역·영역 내부 좌표 모두 같은 y 방향을 사용합니다.

`5760×1200`은 **4.8:1**입니다. `WallTouchReceiver.ToScreen(t)`는 실제 `Screen.width/height`를 사용하고, `ToPixels(t)`는 기본 5760×1200 기준 좌표를 반환합니다. 좌표의 `1`은 화면 가장자리의 폭/높이에 해당합니다. Unity 화면 좌표 원점과 카메라 변환은 [Unity 좌표 API](https://docs.unity3d.com/2021.3/Documentation/ScriptReference/Camera.ScreenToWorldPoint.html)를 참고하세요. 설치와 사용 예제는 [Unity 수신기 README](unity/WallTouch/README.md)에 있습니다.

**slots 모드 (기존 TouchDesigner)**

트랙은 유지되는 동안 같은 slot 번호를 사용합니다. 기존 patch가 `/lidar`를 사용하면 prefix를 `/lidar`로 변경하세요. slots의 `v`는 기존 위→아래 좌표이며 touch용 `yUp` 설정으로 뒤집히지 않습니다.

| Address | OSC type tag | 의미 |
| --- | --- | --- |
| `<prefix>/count` | `,i` | 현재 active track 수 |
| `<prefix>/track/<slot>/active` | `,i` | slot 활성 상태 `0/1` |
| `<prefix>/track/<slot>/u` | `,f` | normalized x 좌표 |
| `<prefix>/track/<slot>/v` | `,f` | normalized y 좌표 |
| `<prefix>/zone/<name>/active` | `,i` | zone 활성 상태 |
| `<prefix>/zone/<name>/count` | `,i` | zone 안의 track 수 |
| `<prefix>/zone/<name>/enter` | `,i` | 진입 이벤트가 발생했을 때만 해당 track ID 전송 |
| `<prefix>/zone/<name>/exit` | `,i` | 이탈 이벤트가 발생했을 때만 해당 track ID 전송 |

`maxSlots`는 slots에만 적용되며 기본 `16`, 범위 `1–32`입니다. 비활성 slot도 `/active 0`을 계속 보내므로 고정 channel 매핑에 사용할 수 있습니다.

## 한계

- 감지는 **2D 스캔 평면 통과**입니다. 실제 벽 접촉 여부를 측정하지 않으므로 벽을 만지지 않아도 소매·팔이 평면을 지나면 터치로 잡힙니다.
- 센서 시점에서 손이 다른 손 바로 뒤에 있으면 가려집니다. 가려진 손을 독립적으로 감지할 수 없습니다.
- 약 10 Hz의 한 회전과 처리를 포함한 지연은 대략 **100–200 ms**이며 평활·트랙 유지 설정에 따라 달라집니다.
- 한 scan보다 짧은 탭은 회전 시점 사이에 끝나 놓칠 수 있습니다.
- 멀수록 점 간격이 커집니다. **6 m에서 약 12 mm** 간격이므로 작은 손가락이나 먼 쪽 터치는 가까운 곳보다 점 수가 적습니다.

## 무인 운영

캘리브레이션, zone, pipeline, OSC 설정과 학습한 배경 기준은 앱의 **userData 폴더**에 자동 저장되고 재시작 시 복원됩니다. `installation.json`에 설치 설정, `background.json`에 센서 주소와 배경 기준, `settings.json`에 마지막 연결 정보를 저장합니다. 배경 기준은 같은 센서 주소에 대해 복원합니다. 센서나 투사 위치가 움직였다면 저장된 보정을 그대로 쓰지 말고 배경 학습과 캘리브레이션을 다시 진행하세요. 별도 preset 파일도 계속 저장/불러올 수 있습니다.

앱은 운영 중 시스템 절전을 억제하고, 센서 연결이 끊기면 자동 재연결합니다. Renderer가 충돌하면 화면을 다시 로드하고 main의 현재 설치 상태를 전달해 복구합니다. 재연결 시 OSC session이 바뀌므로 Unity는 이전 터치를 정리합니다. Unity도 항상 `/frame` timeout을 적용해 앱 종료나 UDP 단절 후 터치가 남지 않게 해야 합니다. 앱 실행 자체가 운영체제 로그인 시 자동 시작된다는 뜻은 아니므로, 전시 PC의 로그인·앱 실행 구성은 별도로 준비합니다.

## 개발 명령

```bash
npm run dev          # Electron/Vite 개발 실행
npm run build        # main/preload/renderer 번들 빌드
npm run typecheck    # TypeScript 검사
npm run bridge       # C++ bridge만 다시 빌드
npm run dist:mac     # unsigned macOS .app 생성
npm run dist:win     # unsigned Windows x64 zip/portable 생성
```

이 저장소에는 별도 test runner나 linter가 없습니다. TypeScript 변경 후에는 최소한 `npm run typecheck`를 실행하세요.

## 구조

```text
bridge/                 Slamtec SDK를 호출하는 C++ 센서 bridge
src/main/               Electron main, bridge 관리, tracking pipeline, OSC
src/main/pipeline/      background, cluster, track, zone evaluation
src/preload/            renderer에 노출되는 안전한 Electron API
src/renderer/           React UI와 Canvas 시각화
src/shared/             main/preload/renderer가 공유하는 타입, IPC, homography, protocol
unity/WallTouch/         Unity OSC 수신기, debug overlay, zone filter와 설치 문서
```

데이터 흐름:

```text
S2E -> C++ bridge -> Electron main -> pipeline -> OSC/UDP -> Unity (touch) / TouchDesigner (slots)
                                 \-> IPC -> React/Canvas renderer
```

## Bridge 경로

개발 모드에서는 기본적으로 `bridge/bin/s2e_bridge`를 실행합니다. Windows에서는 `bridge/bin/s2e_bridge.exe`를 실행합니다. 패키징된 앱에서는 같은 파일명이 `resources/bridge/` 아래에 들어갑니다.

다른 bridge binary를 테스트하려면 환경 변수를 지정하세요.

macOS:

```bash
S2E_BRIDGE_PATH=/absolute/path/to/s2e_bridge npm run dev
```

Windows PowerShell:

```powershell
$env:S2E_BRIDGE_PATH="C:\absolute\path\to\s2e_bridge.exe"
npm run dev
```

## 문제 해결

**Point cloud가 보이지 않음**

- S2E 전원이 켜져 있는지 확인합니다.
- Ethernet IP가 `192.168.11.x/24` 대역인지 확인합니다.
- ARP로 `192.168.11.2` 장비가 보이는지 확인합니다.
- Windows에서는 방화벽에서 앱 또는 `s2e_bridge.exe`의 네트워크 접근이 막히지 않았는지 확인합니다.
- 다른 네트워크 인터페이스가 같은 대역을 잡고 있지 않은지 확인합니다.

**`npm run bridge:setup`이 실패함**

- macOS는 Xcode Command Line Tools가 설치되어 있는지 확인합니다.
- Windows는 Visual Studio 2022 Build Tools와 Desktop development with C++ workload가 설치되어 있는지 확인합니다.
- `git`, 빌드 도구, C++ compiler가 PATH에서 접근 가능한지 확인합니다.
- 네트워크에서 GitHub 접근이 가능한지 확인합니다.

**트랙 ID가 흔들리거나 사람이 여러 개로 쪼개짐**

- 사람이 없는 상태에서 background를 다시 학습합니다.
- `clusterGapMm`, `minClusterPts`, `trackMaxJumpMm`, `smoothing` 값을 현장 크기와 센서 높이에 맞춰 조정합니다.

**Unity에서 터치가 안 들어옴**

- OSC mode가 `touch` 또는 `both`이고 enabled인지 확인합니다.
- 앱과 Unity 수신기의 포트·prefix가 같은지 확인합니다. 기본값은 `7000`, `/wall`입니다.
- 앱의 ReadyReason을 확인하고 캘리브레이션·배경 학습·센서 상태를 해결합니다.
- 활성 터치 영역이 있으면 해당 영역 안에서 손으로 평면을 통과합니다.
- Unity의 F1 overlay에서 Connected와 Ready를 확인합니다.
- Windows Defender 방화벽에서 Unity Editor/실행 파일의 **인바운드 UDP 7000**을 허용합니다. 다른 프로세스가 같은 포트를 점유하면 수신기의 LastError/Console을 확인합니다.

**TouchDesigner에서 OSC가 안 들어옴**

- OSC mode가 `slots` 또는 `both`인지, 기존 patch의 prefix가 맞는지 확인합니다.
- TouchDesigner OSC In 포트가 앱의 OSC 포트와 같은지 확인합니다.
- 같은 컴퓨터이면 host는 `127.0.0.1`을 사용합니다.
- 다른 컴퓨터로 보내려면 host를 수신 컴퓨터의 IP로 바꾸고 방화벽을 확인합니다.

## 라이선스

이 저장소의 코드는 MIT 라이선스로 배포합니다. Slamtec SDK는 별도 라이선스를 따르며 이 저장소에 포함되지 않습니다.
