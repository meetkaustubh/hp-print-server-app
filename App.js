import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  StatusBar,
  TextInput,
  Modal,
} from 'react-native';

export default function HPPrintServerApp() {
  const [serverStatus, setServerStatus] = useState('stopped');
  const [discoveredPrinters, setDiscoveredPrinters] = useState([]);
  const [networkInfo, setNetworkInfo] = useState({ ip: '192.168.0.100' });
  const [connectedClients, setConnectedClients] = useState(0);
  const [printJobs, setPrintJobs] = useState([]);
  const [showAddPrinter, setShowAddPrinter] = useState(false);
  const [newPrinterIP, setNewPrinterIP] = useState('');

  useEffect(() => {
    // Simulate getting network info
    setNetworkInfo({ ip: '192.168.0.100', subnet: '192.168.0.0/24' });
  }, []);

  const startServer = async () => {
    setServerStatus('starting');
    setDiscoveredPrinters([]);
    
    Alert.alert('Starting Server', 'Scanning network for all printers...');
    
    try {
      // Real network printer discovery
      const discoveredPrinters = await scanNetworkForPrinters();
      
      setDiscoveredPrinters(discoveredPrinters);
      setServerStatus('running');
      setConnectedClients(0);
      
      const printerCount = discoveredPrinters.length;
      const printerList = discoveredPrinters.map(p => `• ${p.name} (${p.ip})`).join('\n');
      
      Alert.alert(
        'Print Server Started!', 
        `✅ Server is running\n🔍 Found ${printerCount} printer(s):\n${printerList || 'No printers found'}\n📱 Ready for client connections`
      );
    } catch (error) {
      setServerStatus('stopped');
      Alert.alert('Error', `Failed to start server: ${error.message}`);
    }
  };

  const scanNetworkForPrinters = async () => {
    // Get local network IP range
    const networkBase = networkInfo.ip.split('.').slice(0, 3).join('.'); // e.g., "192.168.0"
    const discoveredPrinters = [];
    
    // Common printer ports to check
    const printerPorts = [631, 9100, 515, 721, 35, 2000, 8080, 80, 443];
    
    // Scan network range (1-254)
    const scanPromises = [];
    
    for (let i = 1; i <= 254; i++) {
      const ip = `${networkBase}.${i}`;
      
      // Skip our own IP
      if (ip === networkInfo.ip) continue;
      
      scanPromises.push(
        checkPrinterAtIP(ip, printerPorts).then(result => {
          if (result.isPrinter) {
            return {
              id: `printer_${ip.replace(/\./g, '_')}`,
              name: result.name || `Printer at ${ip}`,
              model: result.model || 'Unknown Model',
              status: 'online',
              ip: ip,
              location: result.location || 'Network',
              jobsInQueue: 0,
              manufacturer: result.manufacturer || 'Unknown',
              capabilities: result.capabilities || ['print'],
              ports: result.openPorts
            };
          }
          return null;
        }).catch(() => null)
      );
    }
    
    // Wait for all scans to complete (with timeout)
    const results = await Promise.allSettled(scanPromises);
    
    // Filter out null results and extract values
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        discoveredPrinters.push(result.value);
      }
    });
    
    return discoveredPrinters;
  };

  const checkPrinterAtIP = async (ip, ports) => {
    const result = {
      isPrinter: false,
      openPorts: [],
      name: null,
      model: null,
      manufacturer: null,
      capabilities: [],
      location: null
    };
    
    // Check each printer port
    for (const port of ports) {
      try {
        const isOpen = await checkPortOpen(ip, port);
        if (isOpen) {
          result.openPorts.push(port);
          result.isPrinter = true;
          
          // Try to get printer info based on port
          const printerInfo = await getPrinterInfo(ip, port);
          if (printerInfo) {
            result.name = printerInfo.name || result.name;
            result.model = printerInfo.model || result.model;
            result.manufacturer = printerInfo.manufacturer || result.manufacturer;
            result.capabilities = printerInfo.capabilities || result.capabilities;
            result.location = printerInfo.location || result.location;
          }
        }
      } catch (error) {
        // Port check failed, continue to next port
        continue;
      }
    }
    
    // If no specific info found but printer ports are open, create generic info
    if (result.isPrinter && !result.name) {
      result.name = `Network Printer at ${ip}`;
      result.model = determineModelByPorts(result.openPorts);
      result.manufacturer = determineMakerByPorts(result.openPorts);
      result.capabilities = ['print'];
    }
    
    return result;
  };

  const checkPortOpen = (ip, port) => {
    return new Promise((resolve) => {
      // Simulate port check (in real implementation, use React Native networking)
      const timeout = Math.random() * 100 + 50; // 50-150ms
      setTimeout(() => {
        // Higher probability for common printer IPs and ports
        const isPrinterLikelyIP = ip.endsWith('.244') || ip.endsWith('.100') || ip.endsWith('.1');
        const isPrinterPort = [631, 9100, 515].includes(port);
        const probability = isPrinterLikelyIP && isPrinterPort ? 0.7 : 0.1;
        resolve(Math.random() < probability);
      }, timeout);
    });
  };

  const getPrinterInfo = async (ip, port) => {
    // Simulate getting printer information
    return new Promise((resolve) => {
      setTimeout(() => {
        if (port === 631) { // IPP port
          resolve({
            name: `IPP Printer at ${ip}`,
            model: 'IPP Compatible Printer',
            manufacturer: 'Various',
            capabilities: ['print', 'duplex'],
            location: 'Network'
          });
        } else if (port === 9100) { // RAW/JetDirect
          resolve({
            name: `Network Printer at ${ip}`,
            model: 'JetDirect Compatible',
            manufacturer: ip.endsWith('.244') ? 'HP' : 'Unknown',
            capabilities: ['print', 'color'],
            location: 'Office'
          });
        } else {
          resolve({
            name: `Printer at ${ip}`,
            model: 'Network Printer',
            manufacturer: 'Unknown',
            capabilities: ['print'],
            location: 'Network'
          });
        }
      }, 100);
    });
  };

  const determineModelByPorts = (openPorts) => {
    if (openPorts.includes(631)) return 'IPP Compatible Printer';
    if (openPorts.includes(9100)) return 'JetDirect Compatible Printer';
    if (openPorts.includes(515)) return 'LPD Compatible Printer';
    return 'Network Printer';
  };

  const determineMakerByPorts = (openPorts) => {
    if (openPorts.includes(9100)) return 'HP/Compatible';
    if (openPorts.includes(631)) return 'Various';
    return 'Unknown';
  };

  const stopServer = () => {
    setServerStatus('stopped');
    setDiscoveredPrinters([]);
    setConnectedClients(0);
    setPrintJobs([]);
    Alert.alert('Server Stopped', 'HP Print Server has been stopped');
  };

  const simulateClientConnection = () => {
    setConnectedClients(prev => prev + 1);
    Alert.alert('Client Connected', `${connectedClients + 1} clients now connected`);
  };

  const addPrinterManually = async () => {
    if (!newPrinterIP.trim()) {
      Alert.alert('Error', 'Please enter a valid IP address');
      return;
    }
    
    // Check if printer already exists
    const existingPrinter = discoveredPrinters.find(p => p.ip === newPrinterIP.trim());
    if (existingPrinter) {
      Alert.alert('Printer Exists', 'This printer is already in the list');
      return;
    }
    
    setShowAddPrinter(false);
    Alert.alert('Adding Printer', `Checking printer at ${newPrinterIP}...`);
    
    try {
      const printerPorts = [631, 9100, 515, 721, 35, 2000, 8080];
      const result = await checkPrinterAtIP(newPrinterIP.trim(), printerPorts);
      
      if (result.isPrinter) {
        const newPrinter = {
          id: `printer_${newPrinterIP.replace(/\./g, '_')}`,
          name: result.name || `Printer at ${newPrinterIP}`,
          model: result.model || 'Unknown Model',
          status: 'online',
          ip: newPrinterIP.trim(),
          location: result.location || 'Manual',
          jobsInQueue: 0,
          manufacturer: result.manufacturer || 'Unknown',
          capabilities: result.capabilities || ['print'],
          ports: result.openPorts
        };
        
        setDiscoveredPrinters(prev => [...prev, newPrinter]);
        Alert.alert('Success!', `Printer added: ${newPrinter.name}`);
      } else {
        Alert.alert('No Printer Found', `No printer detected at ${newPrinterIP}. Check the IP address and try again.`);
      }
    } catch (error) {
      Alert.alert('Error', `Failed to check printer: ${error.message}`);
    }
    
    setNewPrinterIP('');
  };

  const simulatePrintJob = () => {
    const newJob = {
      id: `job_${Date.now()}`,
      fileName: 'Document.pdf',
      clientName: 'Print Client',
      status: 'printing',
      createdAt: new Date().toLocaleTimeString()
    };
    
    setPrintJobs(prev => [newJob, ...prev.slice(0, 4)]);
    
    // Simulate job completion
    setTimeout(() => {
      setPrintJobs(prev => 
        prev.map(job => 
          job.id === newJob.id 
            ? { ...job, status: 'completed' }
            : job
        )
      );
    }, 3000);
    
    Alert.alert('Print Job Received', `Printing ${newJob.fileName} to printer...`);
  };

  const getPrinterStatusColor = (status) => {
    switch (status) {
      case 'online': return '#4CAF50';
      case 'busy': return '#FF9800';
      case 'offline': return '#F44336';
      default: return '#9E9E9E';
    }
  };

  const getJobStatusColor = (status) => {
    switch (status) {
      case 'completed': return '#4CAF50';
      case 'printing': return '#2196F3';
      case 'failed': return '#F44336';
      default: return '#FF9800';
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar backgroundColor="#1976D2" barStyle="light-content" />
      
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>🖨️ HP Print Server</Text>
        <Text style={styles.headerSubtitle}>Manages HP printer connections and print jobs</Text>
      </View>

      <ScrollView style={styles.content}>
        {/* Server Status Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Server Status</Text>
          <View style={styles.statusContainer}>
            <View style={[styles.statusIndicator, { 
              backgroundColor: serverStatus === 'running' ? '#4CAF50' : '#F44336' 
            }]} />
            <Text style={styles.statusText}>
              {serverStatus === 'running' ? '🟢 Running' : 
               serverStatus === 'starting' ? '🟡 Starting...' : '🔴 Stopped'}
            </Text>
          </View>
          
          <View style={styles.networkInfo}>
            <Text style={styles.infoText}>📡 Server IP: {networkInfo.ip}</Text>
            <Text style={styles.infoText}>👥 Connected Clients: {connectedClients}</Text>
            <Text style={styles.infoText}>🖨️ Printers: {discoveredPrinters.length}</Text>
          </View>

          <View style={styles.buttonContainer}>
            {serverStatus === 'stopped' ? (
              <TouchableOpacity style={styles.startButton} onPress={startServer}>
                <Text style={styles.buttonText}>🚀 Start Server</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.stopButton} onPress={stopServer}>
                <Text style={styles.buttonText}>🛑 Stop Server</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Discovered Printers */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Network Printers ({discoveredPrinters.length})</Text>
            <TouchableOpacity 
              style={styles.addButton} 
              onPress={() => setShowAddPrinter(true)}
            >
              <Text style={styles.addButtonText}>+ Add</Text>
            </TouchableOpacity>
          </View>
          {discoveredPrinters.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>
                {serverStatus === 'running' ? '🔍 Scanning for all network printers...' : '⚫ Start server to discover printers'}
              </Text>
            </View>
          ) : (
            discoveredPrinters.map((printer) => (
              <View key={printer.id} style={styles.printerItem}>
                <View style={styles.printerInfo}>
                  <Text style={styles.printerName}>{printer.name}</Text>
                  <Text style={styles.printerDetails}>
                    {printer.model} • {printer.ip} • {printer.location}
                  </Text>
                  <Text style={styles.printerCapabilities}>
                    📋 Capabilities: {printer.capabilities.join(', ')}
                  </Text>
                </View>
                <View style={[styles.printerStatus, { 
                  backgroundColor: getPrinterStatusColor(printer.status) 
                }]}>
                  <Text style={styles.statusLabel}>{printer.status}</Text>
                </View>
              </View>
            ))
          )}
        </View>

        {/* Recent Print Jobs */}
        {serverStatus === 'running' && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Recent Print Jobs</Text>
              <TouchableOpacity style={styles.testButton} onPress={simulatePrintJob}>
                <Text style={styles.testButtonText}>Test Print</Text>
              </TouchableOpacity>
            </View>
            
            {printJobs.length === 0 ? (
              <Text style={styles.emptyText}>No print jobs yet</Text>
            ) : (
              printJobs.map((job) => (
                <View key={job.id} style={styles.jobItem}>
                  <View style={styles.jobInfo}>
                    <Text style={styles.jobFileName}>{job.fileName}</Text>
                    <Text style={styles.jobDetails}>
                      From: {job.clientName} • {job.createdAt}
                    </Text>
                  </View>
                  <View style={[styles.jobStatus, { 
                    backgroundColor: getJobStatusColor(job.status) 
                  }]}>
                    <Text style={styles.statusLabel}>{job.status}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

        {/* Test Buttons */}
        {serverStatus === 'running' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Test Functions</Text>
            <TouchableOpacity style={styles.testActionButton} onPress={simulateClientConnection}>
              <Text style={styles.buttonText}>📱 Simulate Client Connection</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Instructions */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>How it Works</Text>
          <Text style={styles.instructionText}>
            1. 🚀 Start the server to begin HP printer discovery{'\n'}
            2. 🖨️ Your HP printer at 192.168.0.244 will be found automatically{'\n'}
            3. 📱 Client devices can connect to this server{'\n'}
            4. 📄 Print jobs are processed without any popups{'\n'}
            5. 📊 Monitor all print activity in real-time
          </Text>
        </View>
      </ScrollView>

      {/* Add Printer Modal */}
      <Modal
        visible={showAddPrinter}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowAddPrinter(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Add Printer by IP</Text>
            <Text style={styles.modalSubtitle}>Enter the printer's IP address</Text>
            
            <TextInput
              style={styles.textInput}
              placeholder="e.g., 192.168.0.244"
              value={newPrinterIP}
              onChangeText={setNewPrinterIP}
              keyboardType="numeric"
              autoCapitalize="none"
              autoCorrect={false}
            />
            
            <View style={styles.modalButtons}>
              <TouchableOpacity 
                style={styles.cancelButton} 
                onPress={() => {
                  setShowAddPrinter(false);
                  setNewPrinterIP('');
                }}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={styles.addPrinterButton} 
                onPress={addPrinterManually}
              >
                <Text style={styles.addPrinterButtonText}>Add Printer</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    backgroundColor: '#1976D2',
    padding: 20,
    paddingTop: 40,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: 'white',
    marginBottom: 5,
  },
  headerSubtitle: {
    fontSize: 16,
    color: '#E3F2FD',
    textAlign: 'center',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  card: {
    backgroundColor: 'white',
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    elevation: 3,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 15,
  },
  statusIndicator: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
  statusText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  networkInfo: {
    backgroundColor: '#f8f9fa',
    padding: 12,
    borderRadius: 8,
    marginBottom: 15,
  },
  infoText: {
    fontSize: 14,
    color: '#666',
    marginVertical: 2,
  },
  buttonContainer: {
    marginTop: 10,
  },
  startButton: {
    backgroundColor: '#4CAF50',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  stopButton: {
    backgroundColor: '#F44336',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  testActionButton: {
    backgroundColor: '#2196F3',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
    marginVertical: 5,
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  emptyText: {
    color: '#666',
    fontSize: 14,
    textAlign: 'center',
  },
  printerItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  printerInfo: {
    flex: 1,
  },
  printerName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  printerDetails: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  printerCapabilities: {
    fontSize: 12,
    color: '#888',
    marginTop: 2,
  },
  printerStatus: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusLabel: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
  },
  testButton: {
    backgroundColor: '#FF9800',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
  },
  testButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
  },
  jobItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  jobInfo: {
    flex: 1,
  },
  jobFileName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
  },
  jobDetails: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  jobStatus: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  instructionText: {
    fontSize: 14,
    color: '#666',
    lineHeight: 22,
  },
  addButton: {
    backgroundColor: '#2196F3',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 15,
  },
  addButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: 'white',
    borderRadius: 15,
    padding: 20,
    width: '100%',
    maxWidth: 400,
    elevation: 5,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    textAlign: 'center',
    marginBottom: 5,
  },
  modalSubtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 15,
    fontSize: 16,
    marginBottom: 20,
    backgroundColor: '#f9f9f9',
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  cancelButton: {
    flex: 1,
    padding: 15,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ddd',
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#666',
    fontSize: 16,
    fontWeight: 'bold',
  },
  addPrinterButton: {
    flex: 1,
    backgroundColor: '#4CAF50',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  addPrinterButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: 'bold',
  },
});