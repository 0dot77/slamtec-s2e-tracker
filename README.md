# Slamtec S2E Tracker

Slamtec RPLIDAR **S2E**(Ethernet LiDAR)로 트래킹 영역에 들어온 사람의 위치를 실시간으로 추적하고, **OSC로 TouchDesigner**에 전송하는 독립 데스크톱 앱.

- 트래킹 영역 실시간 시각화 (point cloud)
- 4점 캘리브레이션 → 위치를 **0–1로 정규화** (벽 / 바닥 등 배치 무관)
- 사용자가 그린 **이벤트 존(zone)** 진입 / 이탈 트리거
- 다중 인원 ID 추적
- **OSC** 출력 (TouchDesigner OSC In CHOP / DAT)

## 아키텍처

```
S2E ──UDP(192.168.11.2:8089)──▶ C++ bridge ──binary frames(stdout)──▶ Electron main (TS)
                                                                        ├─ pipeline: bg-subtract → cluster → track → homography → zones
                                                                        ├─ OSC ──UDP──▶ TouchDesigner
                                                                        └─ IPC ──▶ Renderer (React + Canvas)
```

- **bridge/** — 공식 Slamtec SDK 기반의 얇은 C++ 센서 브리지. UDP로 스캔을 받아 compact binary 프레임으로 stdout 스트리밍.
- **src/main/** — Electron main: 브리지 spawn · 프레임 파싱 · 처리 파이프라인 · OSC.
- **src/renderer/** — React + Canvas UI: 시각화 / 캘리브레이션 / 존 편집 / 컨트롤.
- **src/shared/** — 공유 타입 · wire format.

## 하드웨어 / 네트워크 셋업

S2E는 **Ethernet UDP**(`192.168.11.2:8089`), 12V 어댑터 전원(PoE 아님).

1. S2E Ethernet → Mac USB-LAN, 12V 전원 연결.
2. Mac의 해당 Ethernet 어댑터를 **수동 IP**로 설정:
   ```bash
   networksetup -setmanual "USB 10/100/1000 LAN" 192.168.11.100 255.255.255.0
   ```
3. ⚠️ **S2E는 ping(ICMP)에 응답하지 않습니다.** `ping 192.168.11.2` 실패는 정상이며, 연결 확인은 ARP로:
   ```bash
   arp -an | grep 192.168.11.2     # MAC 주소가 보이면 정상 연결
   ```

## 빌드 & 실행

```bash
npm run bridge:setup   # Slamtec SDK 다운로드 + C++ 브리지 빌드 (최초 1회)
npm install            # 의존성 설치
npm run dev            # 개발 실행
```

## 상태

- [x] Phase 0 — 하드웨어 first light (SDK 빌드 · UDP 스캔 수신)
- [x] Phase 1 — C++ 브리지 + 실시간 point cloud 시각화 (~10 Hz)
- [ ] Phase 2 — 배경 제거 · 클러스터링 · 다중 ID 추적
- [ ] Phase 3 — 4점 homography 캘리브레이션
- [ ] Phase 4 — 이벤트 존 + OSC 출력
- [ ] Phase 5 — 안정화 · 패키징(.app)

## 라이선스

MIT (본 저장소 코드). Slamtec SDK는 별도 라이선스이며 본 저장소에 포함되지 않습니다.
