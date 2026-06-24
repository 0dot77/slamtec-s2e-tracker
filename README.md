# Slamtec S2E Tracker

Slamtec RPLIDAR **S2E**로 사람의 위치를 실시간 추적하고, 정규화된 좌표와 zone enter/exit 이벤트를 **OSC**로 보내는 Electron 데스크톱 앱입니다. 설치형 인터랙티브 작업, TouchDesigner 프로토타입, 전시장/무대 바닥 트래킹을 빠르게 구성하는 용도로 만들었습니다.

주요 기능:

- S2E Ethernet LiDAR 스캔 수신 및 실시간 point cloud 표시
- 배경 학습 기반 foreground 분리
- gap 기반 클러스터링과 다중 사람 ID 트래킹
- 4점 캘리브레이션으로 LiDAR mm 좌표를 normalized `[0, 1]` 좌표로 변환
- 캔버스 위에서 직접 그리는 이벤트 zone
- TouchDesigner에서 받기 쉬운 고정 slot 기반 OSC 출력
- 캘리브레이션, zone, pipeline/OSC 설정 preset 저장/불러오기

## 지원 환경

- macOS
- Node.js 20 이상 권장
- Xcode Command Line Tools 또는 `make`/C++ 빌드 도구
- Slamtec RPLIDAR S2E
- S2E용 12V 전원 어댑터
- Mac과 S2E를 연결할 Ethernet 또는 USB-LAN 어댑터

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
2. S2E Ethernet을 Mac의 Ethernet/USB-LAN 어댑터에 연결합니다.
3. Mac의 해당 네트워크 인터페이스를 수동 IP로 설정합니다.

```bash
networksetup -setmanual "USB 10/100/1000 LAN" 192.168.11.100 255.255.255.0
```

인터페이스 이름은 Mac 환경마다 다릅니다. 현재 서비스 이름은 다음 명령으로 확인할 수 있습니다.

```bash
networksetup -listallnetworkservices
```

S2E는 ICMP ping에 응답하지 않을 수 있습니다. `ping 192.168.11.2` 실패만으로 연결 실패라고 판단하지 말고 ARP를 확인하세요.

```bash
arp -an | grep 192.168.11.2
```

MAC 주소가 보이면 물리 연결과 IP 대역 설정은 대체로 정상입니다.

## 앱 사용 순서

1. `npm run dev`로 앱을 실행합니다.
2. **Start**를 눌러 S2E bridge를 시작합니다.
3. LiDAR point cloud가 보이는지 확인합니다.
4. 추적 영역을 비운 상태에서 **Learn background**를 눌러 배경을 학습합니다.
5. **Calibrate** 모드에서 실제 트래킹 영역의 네 모서리를 순서대로 찍습니다.
   - 1번: normalized `(0, 0)`
   - 2번: normalized `(1, 0)`
   - 3번: normalized `(1, 1)`
   - 4번: normalized `(0, 1)`
6. **Zones** 모드에서 **+ Draw zone**을 눌러 바닥 위에 polygon zone을 그립니다.
   - 클릭: 점 추가
   - 첫 점 근처 클릭, double click, 또는 Enter: zone 완료
   - Esc: 작성 취소
   - vertex drag: zone 모양 수정
7. TouchDesigner에서 OSC In CHOP/DAT를 열고 기본 포트 `7000`을 받습니다.
8. 필요하면 preset으로 현재 설정을 저장합니다.

캘리브레이션 전에도 point cloud와 기본 트래킹은 볼 수 있지만, zone 작성은 캘리브레이션 이후에 사용하는 것이 안전합니다. Zone polygon은 normalized 공간에 저장되므로 센서 위치가 바뀌면 캘리브레이션을 다시 잡으세요.

## OSC 출력

기본 목적지는 `127.0.0.1:7000`, 주소 prefix는 `/lidar`입니다.

트랙은 안정적인 slot에 고정됩니다. 같은 사람이 유지되는 동안 같은 slot 번호를 쓰므로 TouchDesigner에서 고정 channel로 매핑하기 쉽습니다.

| Address | Type | Description |
| --- | --- | --- |
| `/lidar/count` | int | 현재 active track 수 |
| `/lidar/track/<slot>/active` | int | slot 활성 상태, `0` 또는 `1` |
| `/lidar/track/<slot>/u` | float | normalized x 좌표 |
| `/lidar/track/<slot>/v` | float | normalized y 좌표 |
| `/lidar/zone/<name>/active` | int | zone 활성 상태 |
| `/lidar/zone/<name>/count` | int | zone 안의 track 수 |
| `/lidar/zone/<name>/enter` | int | 이번 frame에 진입한 track id, 없으면 `0` |
| `/lidar/zone/<name>/exit` | int | 이번 frame에 이탈한 track id, 없으면 `0` |

`maxSlots` 기본값은 `16`입니다. 비활성 slot도 `/active 0`으로 계속 보내기 때문에 수신 쪽 patch를 단순하게 유지할 수 있습니다.

## 개발 명령

```bash
npm run dev          # Electron/Vite 개발 실행
npm run build        # main/preload/renderer 번들 빌드
npm run typecheck    # TypeScript 검사
npm run bridge       # C++ bridge만 다시 빌드
npm run dist:mac     # unsigned macOS .app 생성
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
```

데이터 흐름:

```text
S2E -> C++ bridge -> Electron main -> pipeline -> OSC
                                 \-> IPC -> React/Canvas renderer
```

## Bridge 경로

개발 모드에서는 기본적으로 `bridge/s2e_bridge`를 실행합니다. 패키징된 앱에서는 `resources/bridge/s2e_bridge`를 사용합니다.

다른 bridge binary를 테스트하려면 환경 변수를 지정하세요.

```bash
S2E_BRIDGE_PATH=/absolute/path/to/s2e_bridge npm run dev
```

## 문제 해결

**Point cloud가 보이지 않음**

- S2E 전원이 켜져 있는지 확인합니다.
- Mac Ethernet IP가 `192.168.11.x/24` 대역인지 확인합니다.
- `arp -an | grep 192.168.11.2`로 장비가 보이는지 확인합니다.
- 방화벽 또는 다른 네트워크 인터페이스가 UDP 수신을 막고 있지 않은지 확인합니다.

**`npm run bridge:setup`이 실패함**

- Xcode Command Line Tools가 설치되어 있는지 확인합니다.
- `git`, `make`, C++ compiler가 PATH에 있는지 확인합니다.
- 네트워크에서 GitHub 접근이 가능한지 확인합니다.

**트랙 ID가 흔들리거나 사람이 여러 개로 쪼개짐**

- 사람이 없는 상태에서 background를 다시 학습합니다.
- `clusterGapMm`, `minClusterPts`, `trackMaxJumpMm`, `smoothing` 값을 현장 크기와 센서 높이에 맞춰 조정합니다.

**TouchDesigner에서 OSC가 안 들어옴**

- TouchDesigner OSC In 포트가 앱의 OSC 포트와 같은지 확인합니다.
- 같은 Mac이면 host는 `127.0.0.1`을 사용합니다.
- 다른 컴퓨터로 보내려면 host를 수신 컴퓨터의 IP로 바꾸고 방화벽을 확인합니다.

## 라이선스

이 저장소의 코드는 MIT 라이선스로 배포합니다. Slamtec SDK는 별도 라이선스를 따르며 이 저장소에 포함되지 않습니다.
