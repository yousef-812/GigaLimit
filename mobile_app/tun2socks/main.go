package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/sagernet/gvisor/pkg/buffer"
	"github.com/sagernet/gvisor/pkg/tcpip"
	"github.com/sagernet/gvisor/pkg/tcpip/adapters/gonet"
	"github.com/sagernet/gvisor/pkg/tcpip/header"
	"github.com/sagernet/gvisor/pkg/tcpip/link/channel"
	"github.com/sagernet/gvisor/pkg/tcpip/network/ipv4"
	"github.com/sagernet/gvisor/pkg/tcpip/network/ipv6"
	"github.com/sagernet/gvisor/pkg/tcpip/stack"
	"github.com/sagernet/gvisor/pkg/tcpip/transport/tcp"
	"github.com/sagernet/gvisor/pkg/tcpip/transport/udp"
	"github.com/sagernet/gvisor/pkg/waiter"
	"golang.org/x/sys/unix"
)

const (
	channelSize = 4096
	nicID       tcpip.NICID = 1
	mtuVal                   = 1500
	tcpIdleTimeout           = 5 * time.Minute
	udpIdleTimeout           = 60 * time.Second
	dialTimeout              = 5 * time.Second
)

var tcpBufPool = sync.Pool{
	New: func() any {
		b := make([]byte, 32*1024)
		return &b
	},
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: %s <tun_fd> <socks5_host:port>\n", os.Args[0])
		os.Exit(1)
	}

	fd, err := strconv.Atoi(os.Args[1])
	if err != nil {
		log.Fatalf("Invalid fd: %v", err)
	}

	socksAddr := os.Args[2]
	host, portStr, err := net.SplitHostPort(socksAddr)
	if err != nil {
		log.Fatalf("Invalid socks5 address %q: %v", socksAddr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		log.Fatalf("Invalid socks5 port: %v", err)
	}

	log.Printf("tun2socks: fd=%d proxy=socks5://%s:%d", fd, host, port)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	s := stack.New(stack.Options{
		NetworkProtocols: []stack.NetworkProtocolFactory{
			ipv4.NewProtocol,
			ipv6.NewProtocol,
		},
		TransportProtocols: []stack.TransportProtocolFactory{
			tcp.NewProtocol,
			udp.NewProtocol,
		},
		HandleLocal: false,
	})

	ep := channel.New(channelSize, mtuVal, "")

	if tcpipErr := s.CreateNIC(nicID, ep); tcpipErr != nil {
		log.Fatalf("CreateNIC: %v", tcpipErr)
	}

	s.SetRouteTable([]tcpip.Route{
		{Destination: header.IPv4EmptySubnet, NIC: nicID},
		{Destination: header.IPv6EmptySubnet, NIC: nicID},
	})

	s.SetPromiscuousMode(nicID, true)
	s.SetSpoofing(nicID, true)

	twTimeout := tcpip.TCPTimeWaitTimeoutOption(0)
	s.SetTransportProtocolOption(tcp.ProtocolNumber, &twTimeout)
	twReuse := tcpip.TCPTimeWaitReuseOption(tcpip.TCPTimeWaitReuseGlobal)
	s.SetTransportProtocolOption(tcp.ProtocolNumber, &twReuse)
	linger := tcpip.TCPLingerTimeoutOption(time.Second)
	s.SetTransportProtocolOption(tcp.ProtocolNumber, &linger)

	tcpForwarder := tcp.NewForwarder(s, 65535, 1024, func(r *tcp.ForwarderRequest) {
		go handleTCP(ctx, r, host, port)
	})
	s.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpForwarder.HandlePacket)

	udpForwarder := udp.NewForwarder(s, func(r *udp.ForwarderRequest) bool {
		go handleUDP(ctx, r, host, port)
		return true
	})
	s.SetTransportProtocolHandler(udp.ProtocolNumber, udpForwarder.HandlePacket)

	dupFD, err := unix.Dup(fd)
	if err != nil {
		s.Close()
		log.Fatalf("dup fd: %v", err)
	}
	unix.CloseOnExec(dupFD)
	if err := unix.SetNonblock(dupFD, true); err != nil {
		unix.Close(dupFD)
		s.Close()
		log.Fatalf("set nonblock: %v", err)
	}
	tunFile := os.NewFile(uintptr(dupFD), "tun")

	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, mtuVal+4)
		for {
			n, readErr := tunFile.Read(buf)
			if readErr != nil {
				return
			}
			if n == 0 {
				continue
			}
			pkt := buf[:n]
			var proto tcpip.NetworkProtocolNumber
			switch pkt[0] >> 4 {
			case 4:
				proto = header.IPv4ProtocolNumber
			case 6:
				proto = header.IPv6ProtocolNumber
			default:
				continue
			}
			pkb := stack.NewPacketBuffer(stack.PacketBufferOptions{
				Payload: buffer.MakeWithData(pkt),
			})
			ep.InjectInbound(proto, pkb)
			pkb.DecRef()
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			pkt := ep.ReadContext(ctx)
			if pkt == nil {
				return
			}
			v := pkt.ToView()
			data := v.AsSlice()
			tunFile.Write(data)
			v.Release()
			pkt.DecRef()
		}
	}()

	log.Printf("tun2socks: engine started")
	wg.Wait()
	s.Close()
	log.Printf("tun2socks: engine stopped")
}

func socks5Handshake(conn net.Conn) error {
	_, err := conn.Write([]byte{0x05, 0x01, 0x00})
	if err != nil {
		return err
	}
	resp := make([]byte, 2)
	if _, err := io.ReadFull(conn, resp); err != nil {
		return err
	}
	if resp[0] != 0x05 || resp[1] != 0x00 {
		return fmt.Errorf("socks5 handshake failed: %x", resp)
	}
	return nil
}

func socks5Connect(conn net.Conn, dstIP net.IP, dstPort uint16) error {
	var atyp byte
	var addr []byte
	if v4 := dstIP.To4(); v4 != nil {
		atyp = 0x01
		addr = v4
	} else {
		atyp = 0x04
		addr = dstIP.To16()
	}

	req := make([]byte, 0, 6+len(addr))
	req = append(req, 0x05, 0x01, 0x00, atyp)
	req = append(req, addr...)
	req = append(req, byte(dstPort>>8), byte(dstPort))

	if _, err := conn.Write(req); err != nil {
		return err
	}

	hdr := make([]byte, 4)
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return err
	}
	if hdr[0] != 0x05 || hdr[1] != 0x00 {
		return fmt.Errorf("socks5 CONNECT rejected: %x", hdr[1])
	}

	var addrLen int
	switch hdr[3] {
	case 0x01:
		addrLen = 4
	case 0x04:
		addrLen = 16
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(conn, l); err != nil {
			return err
		}
		addrLen = int(l[0])
	default:
		return fmt.Errorf("unsupported atyp: %x", hdr[3])
	}
	skip := make([]byte, addrLen+2)
	if _, err := io.ReadFull(conn, skip); err != nil {
		return err
	}
	return nil
}

func handleTCP(ctx context.Context, req *tcp.ForwarderRequest, socksHost string, socksPort int) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("tcp panic: %v", r)
		}
	}()

	id := req.ID()
	dstIP := net.IP(id.LocalAddress.AsSlice())
	dstPort := id.LocalPort

	var wq waiter.Queue
	ep, tcpipErr := req.CreateEndpoint(&wq)
	if tcpipErr != nil {
		req.Complete(true)
		return
	}
	req.Complete(false)
	ep.SocketOptions().SetKeepAlive(false)
	gonetConn := gonet.NewTCPConn(&wq, ep)

	d := net.Dialer{Timeout: dialTimeout}
	proxyConn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", socksHost, socksPort))
	if err != nil {
		log.Printf("socks5 dial failed: %v", err)
		gonetConn.Close()
		return
	}

	if err := proxyConn.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		proxyConn.Close()
		gonetConn.Close()
		return
	}
	if err := socks5Handshake(proxyConn); err != nil {
		proxyConn.Close()
		gonetConn.Close()
		return
	}
	if err := socks5Connect(proxyConn, dstIP, dstPort); err != nil {
		proxyConn.Close()
		gonetConn.Close()
		return
	}
	proxyConn.SetDeadline(time.Time{})

	pipeConn(gonetConn, proxyConn)
}

func handleUDP(ctx context.Context, req *udp.ForwarderRequest, socksHost string, socksPort int) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("udp panic: %v", r)
		}
	}()

	id := req.ID()
	dstIP := net.IP(id.LocalAddress.AsSlice())
	dstPort := id.LocalPort

	var wq waiter.Queue
	ep, tcpipErr := req.CreateEndpoint(&wq)
	if tcpipErr != nil {
		return
	}
	gonetConn := gonet.NewUDPConn(&wq, ep)

	d := net.Dialer{Timeout: dialTimeout}
	ctrlConn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", socksHost, socksPort))
	if err != nil {
		gonetConn.Close()
		return
	}

	if err := ctrlConn.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		ctrlConn.Close()
		gonetConn.Close()
		return
	}
	if err := socks5Handshake(ctrlConn); err != nil {
		ctrlConn.Close()
		gonetConn.Close()
		return
	}

	localUDP, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		ctrlConn.Close()
		gonetConn.Close()
		return
	}
	boundPort := localUDP.LocalAddr().(*net.UDPAddr).Port

	reqPkt := []byte{0x05, 0x03, 0x00, 0x01, 127, 0, 0, 1, byte(boundPort >> 8), byte(boundPort)}
	if _, err := ctrlConn.Write(reqPkt); err != nil {
		localUDP.Close()
		ctrlConn.Close()
		gonetConn.Close()
		return
	}

	relayAddr := make([]byte, 4)
	if _, err := io.ReadFull(ctrlConn, relayAddr); err != nil {
		localUDP.Close()
		ctrlConn.Close()
		gonetConn.Close()
		return
	}
	if relayAddr[0] != 0x05 || relayAddr[1] != 0x00 {
		localUDP.Close()
		ctrlConn.Close()
		gonetConn.Close()
		return
	}
	var rAddrLen int
	switch relayAddr[3] {
	case 0x01:
		rAddrLen = 4
	case 0x04:
		rAddrLen = 16
	default:
		localUDP.Close()
		ctrlConn.Close()
		gonetConn.Close()
		return
	}
	rAddrBuf := make([]byte, rAddrLen+2)
	if _, err := io.ReadFull(ctrlConn, rAddrBuf); err != nil {
		localUDP.Close()
		ctrlConn.Close()
		gonetConn.Close()
		return
	}
	relayIP := net.IP(rAddrBuf[:rAddrLen])
	relayPort := binary.BigEndian.Uint16(rAddrBuf[rAddrLen:])
	relayUDPAddr := &net.UDPAddr{IP: relayIP, Port: int(relayPort)}

	ctrlConn.SetDeadline(time.Time{})

	defer localUDP.Close()
	defer ctrlConn.Close()
	defer gonetConn.Close()

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		buf := make([]byte, mtuVal)
		for {
			gonetConn.SetReadDeadline(time.Now().Add(udpIdleTimeout))
			n, _, err := gonetConn.ReadFrom(buf)
			if err != nil {
				return
			}
			hdr := []byte{0, 0, 0, 0x01}
			hdr = append(hdr, dstIP.To4()...)
			hdr = append(hdr, byte(dstPort>>8), byte(dstPort))
			dgram := append(hdr, buf[:n]...)
			localUDP.WriteToUDP(dgram, relayUDPAddr)
		}
	}()

	go func() {
		defer wg.Done()
		buf := make([]byte, mtuVal+22)
		for {
			localUDP.SetReadDeadline(time.Now().Add(udpIdleTimeout))
			n, from, err := localUDP.ReadFromUDP(buf)
			if err != nil {
				return
			}
			if from == nil || !from.IP.Equal(relayUDPAddr.IP) || from.Port != relayUDPAddr.Port {
				continue
			}
			if n < 4 || buf[2] != 0 {
				continue
			}
			var pLen int
			switch buf[3] {
			case 0x01:
				pLen = 4
			case 0x04:
				pLen = 16
			default:
				continue
			}
			if n < 4+pLen+2 {
				continue
			}
			payload := buf[4+pLen+2 : n]
			gonetConn.Write(payload)
		}
	}()

	wg.Wait()
}

func pipeConn(a, b net.Conn) {
	defer a.Close()
	defer b.Close()

	var wg sync.WaitGroup
	wg.Add(2)

	pipe := func(dst, src net.Conn) {
		defer wg.Done()
		bufPtr := tcpBufPool.Get().(*[]byte)
		buf := *bufPtr
		defer tcpBufPool.Put(bufPtr)
		for {
			src.SetReadDeadline(time.Now().Add(tcpIdleTimeout))
			n, err := src.Read(buf)
			if n > 0 {
				dst.SetWriteDeadline(time.Now().Add(tcpIdleTimeout))
				if _, werr := dst.Write(buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}

	go pipe(b, a)
	go pipe(a, b)
	wg.Wait()
}
